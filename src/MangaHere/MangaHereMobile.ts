import {
    Chapter,
    SourceManga,
    Tag,
    TagSection
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

/*
 * Depuis fin 2026, les pages /manga/<id>/ du site desktop redirigent de HTTPS vers HTTP,
 * et les couvertures sont servies en http://. iOS bloque le HTTP (App Transport Security) :
 * les couvertures ne s'affichent pas et la fiche manga part en timeout.
 * Le site mobile reste en HTTPS, donc la fiche et la liste des chapitres sont lues dessus.
 */

export interface MobileSiteOptions {
    authorSelector: string
    genreSelector: string
    genreIdRegex: RegExp
}

// Force les URLs en HTTPS (http:// et // sont bloqués ou mal gérés sur iOS)
export const fixUrl = (url: string | undefined): string => {
    if (!url) return ''
    url = url.trim()
    if (url.startsWith('//')) return `https:${url}`
    if (url.startsWith('http://')) return `https://${url.substring(7)}`
    return url
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const cleanText = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

const DATE_REGEX = /(today|yesterday|just now|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|[a-z]{3,9}\.?\s+\d{1,2},\s*\d{4})\s*$/i

export const parseMobileDate = (raw: string): Date | undefined => {
    const date = raw.trim()
    const upper = date.toUpperCase()
    const now = Date.now()
    const num = Number((/\d+/.exec(date) ?? ['1'])[0])

    if (upper.includes('TODAY') || upper.includes('JUST NOW')) return new Date(now)
    if (upper.includes('YESTERDAY')) return new Date(now - 86400000)
    if (upper.includes('AGO')) {
        if (upper.includes('SECOND')) return new Date(now - num * 1000)
        if (upper.includes('MINUTE')) return new Date(now - num * 60000)
        if (upper.includes('HOUR')) return new Date(now - num * 3600000)
        if (upper.includes('DAY')) return new Date(now - num * 86400000)
        if (upper.includes('WEEK')) return new Date(now - num * 604800000)
        if (upper.includes('MONTH')) return new Date(now - num * 2592000000)
        if (upper.includes('YEAR')) return new Date(now - num * 31556952000)
    }

    const parsed = new Date(date)
    return isNaN(parsed.getTime()) ? undefined : parsed
}

const findDescription = ($: CheerioAPI): string => {
    for (const selector of ['[class*="summary"]', '[id*="summary"]', '[class*="intro"]', '[class*="desc"]']) {
        const text = cleanText($(selector).first().text()).replace(/^summary\s*:?\s*/i, '')
        if (text.length > 40) return text
    }

    // Repli : le bloc qui suit un intitulé "Summary"
    const heading = $('h1, h2, h3, h4, h5, p, div, span')
        .filter((_, el) => /^summary\s*:?$/i.test(cleanText($(el).text())))
        .first()
    if (heading.length) {
        const next = cleanText(heading.next().text())
        if (next.length > 20) return next
        const parentNext = cleanText(heading.parent().next().text())
        if (parentNext.length > 20) return parentNext
    }

    return cleanText($('meta[name="description"]').attr('content'))
}

export const parseMobileMangaDetails = ($: CheerioAPI, mangaId: string, options: MobileSiteOptions): SourceManga => {
    const cover = $('img[src*="/store/manga/"]').first()
    const image = fixUrl(cover.attr('src'))

    const titleFromMeta = cleanText($('meta[property="og:title"]').attr('content')).split(/\s[-|]\s/)[0]
    const titleFromTag = cleanText($('title').first().text()).split(/\s[-|]\s/)[0]
    const title = cleanText(cover.attr('alt')) || titleFromMeta || titleFromTag || mangaId.replace(/_/g, ' ')

    const authors = Array.from(new Set($(options.authorSelector).toArray().map(a => cleanText($(a).text())).filter(x => x)))
    const author = authors.join(', ')

    const arrayTags: Tag[] = []
    for (const tag of $(options.genreSelector).toArray()) {
        const id = $(tag).attr('href')?.match(options.genreIdRegex)?.[1]
        const label = cleanText($(tag).text())
        if (!id || !label || arrayTags.some(t => t.id === id)) continue
        arrayTags.push({ id, label })
    }
    const tagSections: TagSection[] = [App.createTagSection({ id: '0', label: 'genres', tags: arrayTags.map(x => App.createTag(x)) })]

    const rawStatus = $('body').text().match(/Status\s*:\s*(Ongoing|Completed|Complete)/i)?.[1] ?? ''
    const status = rawStatus.toUpperCase().startsWith('COMPLETE') ? 'Completed' : 'Ongoing'

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title],
            image,
            status,
            author,
            artist: author,
            tags: tagSections,
            desc: findDescription($)
        })
    })
}

export const parseMobileChapters = ($: CheerioAPI, mangaId: string): Chapter[] => {
    const chapters: Chapter[] = []
    const seen = new Set<string>()
    // ID compatible avec l'ancien site desktop : "c901" ou "v01/c001"
    const hrefRegex = new RegExp(`/manga/${escapeRegex(mangaId)}/((?:v[^/]+/)?c[^/]+)/`)

    for (const link of $('a[href*="/manga/"]').toArray()) {
        const href = $(link).attr('href') ?? ''
        const chapterId = href.match(hrefRegex)?.[1]
        if (!chapterId || seen.has(chapterId)) continue

        const text = cleanText($(link).text())
        // Ignore les boutons type "Read now" qui pointent aussi vers un chapitre
        if (!/\b(?:ch(?:apter)?|c)\.?\s*\d/i.test(text)) continue
        seen.add(chapterId)

        const dateMatch = text.match(DATE_REGEX)
        let name = dateMatch ? text.substring(0, dateMatch.index).trim() : text
        name = name.replace(/\s+new$/i, '').replace(/^C\.\s*/, 'Ch. ').trim()

        const chapNum = Number(chapterId.match(/c([0-9.]+)/)?.[1] ?? 0)
        const volNum = Number(chapterId.match(/v([0-9.]+)/)?.[1] ?? 0)

        chapters.push(App.createChapter({
            id: chapterId,
            name,
            langCode: '🇬🇧',
            chapNum: isNaN(chapNum) ? 0 : chapNum,
            volume: isNaN(volNum) ? 0 : volNum,
            time: dateMatch ? parseMobileDate(dateMatch[1] ?? '') : undefined
        }))
    }

    if (chapters.length == 0) {
        throw new Error(`Couldn't find any chapters for mangaId: ${mangaId}!`)
    }

    return chapters
}

// Lecteur mobile "roll_manga" : toutes les pages du chapitre sont dans #viewer (chargées en différé)
export const parseMobileChapterPages = ($: CheerioAPI): string[] => {
    const pages: string[] = []
    for (const img of $('#viewer img').toArray()) {
        const src = $(img).attr('data-original') || $(img).attr('data-src') || $(img).attr('src') || ''
        if (!src || /loading/i.test(src)) continue
        const url = fixUrl(src)
        if (!pages.includes(url)) pages.push(url)
    }
    return pages
}
