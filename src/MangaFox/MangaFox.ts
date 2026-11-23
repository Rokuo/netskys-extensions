import {
    SourceManga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    TagSection,
    ContentRating,
    Request,
    Response,
    SourceIntents,
    ChapterProviding,
    MangaProviding,
    SearchResultsProviding,
    Tag,
    HomePageSectionsProviding
} from '@paperback/types'

import * as cheerio from 'cheerio'

import {
    isLastPage,
    parseTags,
    parseChapterDetails,
    parseChapters,
    parseHomeSections,
    parseMangaDetails,
    parseSearch,
    parseViewMore
} from './MangaFoxParser'

import { URLBuilder } from './MangaFoxHelper'

import {
    parseMobileChapterPages,
    parseMobileChapters,
    parseMobileMangaDetails
} from './MangaFoxMobile'

const FF_DOMAIN = 'https://fanfox.net'
// Le site desktop redirige les fiches manga vers HTTP (bloqué par iOS) : on passe par le mobile
const FF_MOBILE = 'https://m.fanfox.net'

const FF_MOBILE_OPTIONS = {
    authorSelector: 'a[href*="/search/author/"]',
    genreSelector: 'a[href*="/search/cate/"]',
    genreIdRegex: /\/search\/cate\/([^/?#]+)/
}

export const MangaFoxInfo: SourceInfo = {
    version: '3.0.8',
    name: 'MangaFox',
    icon: 'icon.png',
    author: 'Netsky',
    authorWebsite: 'https://github.com/TheNetsky',
    description: 'Extension that pulls manga from fanfox.net',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: FF_DOMAIN,
    sourceTags: [],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class MangaFox implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {

    requestManager = App.createRequestManager({
        requestsPerSecond: 5,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                const headers = request.headers ?? {}
                request.headers = {
                    ...headers,
                    ...{
                        // On garde un referer déjà fourni (ex. lecteur mobile)
                        'referer': headers['referer'] ?? headers['Referer'] ?? `${FF_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }
                request.cookies = [
                    ...(request.cookies ?? []),
                    App.createCookie({ name: 'isAdult', value: '1', domain: 'm.fanfox.net' }),
                    App.createCookie({ name: 'readway', value: '2', domain: 'm.fanfox.net' }),
                    App.createCookie({ name: 'isAdult', value: '1', domain: 'fanfox.net' })
                ]
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    });

    getMangaShareUrl(mangaId: string): string { return `${FF_DOMAIN}/manga/${mangaId}` }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request = App.createRequest({
            url: `${FF_MOBILE}/manga/${mangaId}/`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        // Ancien parseur desktop gardé si jamais le site mobile renvoie la mise en page desktop
        if ($('.detail-info').length) return parseMangaDetails($, mangaId)
        return parseMobileMangaDetails($, mangaId, FF_MOBILE_OPTIONS)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const request = App.createRequest({
            url: `${FF_MOBILE}/manga/${mangaId}/`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        if ($('div#chapterlist').length) return parseChapters($, mangaId)
        return parseMobileChapters($, mangaId)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        // 1) Lecteur mobile en HTTPS, toutes les pages d'un coup (même méthode que Mihon)
        try {
            const mobileRequest = App.createRequest({
                url: `${FF_MOBILE}/roll_manga/${mangaId}/${chapterId}/1.html`,
                method: 'GET',
                headers: {
                    'referer': `${FF_MOBILE}/`
                }
            })
            const mobileResponse = await this.requestManager.schedule(mobileRequest, 1)
            const pages = parseMobileChapterPages(cheerio.load(mobileResponse.data as string))
            if (pages.length) {
                return App.createChapterDetails({
                    id: chapterId,
                    mangaId: mangaId,
                    pages: pages
                })
            }
        } catch (error) {
            console.log(`MangaFox: mobile reader failed, falling back to desktop: ${error}`)
        }

        // 2) Repli : ancien lecteur desktop
        const request = App.createRequest({
            url: `${FF_DOMAIN}/manga/${mangaId}/${chapterId}/1.html`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        return parseChapterDetails($, mangaId, chapterId, request.url, this)
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const request = App.createRequest({
            url: FF_DOMAIN,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        parseHomeSections($, sectionCallback)
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1
        let param = ''

        switch (homepageSectionId) {
            case 'hot_release':
                param = 'hot'
                break
            case 'new_manga':
                param = `directory/${page}.html?news`
                break
            case 'latest_updates':
                param = `releases/${page}.html`
                break
            default:
                throw new Error(`Invalid homeSectionId | ${homepageSectionId}`)
        }

        const request = App.createRequest({
            url: `${FF_DOMAIN}/${param}`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        const manga = parseViewMore($, homepageSectionId)

        metadata = !isLastPage($) ? { page: page + 1 } : undefined
        return App.createPagedResults({
            results: manga,
            metadata
        })
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1

        const url = new URLBuilder(FF_DOMAIN)
            .addPathComponent('search')
            .addQueryParameter('page', page)
            .addQueryParameter('title', encodeURI(query?.title || ''))
            .addQueryParameter('genres', query.includedTags?.map((x: Tag) => x.id).join('%2C'))
            .buildUrl()

        const request = App.createRequest({
            url: url,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        const manga = parseSearch($)

        metadata = !isLastPage($) ? { page: page + 1 } : undefined
        return App.createPagedResults({
            results: manga,
            metadata
        })
    }

    async getSearchTags(): Promise<TagSection[]> {
        const request = App.createRequest({
            url: `${FF_DOMAIN}/search?`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        const $ = cheerio.load(response.data as string)
        return parseTags($)
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: FF_DOMAIN,
            method: 'GET',
            headers: {
                'referer': `${FF_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }
}
