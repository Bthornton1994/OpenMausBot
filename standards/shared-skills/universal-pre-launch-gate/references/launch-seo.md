# Launch and SEO (public web)

Platform-dependent. Applies when the candidate ships public web pages or shareable links. API-only or store-only products: NOT APPLICABLE with a stated owner of the public page. Candidate items from untrusted X posts `2101154043720876226`, `2098985979067724192`, `2105877938285744551`, `2106240327569035424`, `2101279516912238969`.

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| W1 | HTTPS on the public origin | 8 / web | Live or preview URL uses HTTPS; HTTP redirects or is not offered. |
| W2 | Per-page title and meta description | 14 | Fetched HTML for each launch-critical URL. |
| W3 | Canonical URL | 14 | Canonical link present and matches the intended public URL. |
| W4 | Open Graph / social preview | 14 | `og:title`, `og:description`, `og:image`; fetch the image URL and record status. Reply `2101279516912238969` asked for Open Graph and `sitemap.xml`; treat those as W4 and W6. |
| W5 | Favicon | 14 | Icon request returns an image (not 404). |
| W6 | `sitemap.xml` and `robots.txt` | 14 | Both fetched. `robots.txt` does not Disallow the launch pages or add `noindex` by accident. Sitemap lists the intended URLs. |
| W7 | No accidental `noindex` on launch pages | 14 | HTML/headers checked on the candidate URL. |
| W8 | One H1 per launch page; alt text on content images | 14 | Fetched HTML. Decorative images may be empty alt with a reason. |
| W9 | Broken launch links | 11 | Crawl or click-through of nav, footer, and CTA targets; record 404s. |
| W10 | Image weight / layout shift | 13 | Representative page: oversized uncompressed heroes fixed or remaining decision documented. |
| W11 | Mobile viewport | 12, 13 | Critical flow on a phone-class viewport. |
| W12 | Search Console / Bing / sitemap submit | 14 | Owner action. If not done, remaining owner action, not a code FAIL. Do not create accounts. |
| W13 | Local business profile, review directories, backlinks | — | Marketing, not this gate. Remaining risk at most. |

Server-side render vs client-only: if launch pages are public marketing or docs, record whether the HTML fetched without executing JS contains the title and primary content. A blank shell is FAIL for those pages, or UNKNOWN if not fetched.

Cookie consent banners (posts `2101154043720876226`, `2098985979067724192`) are legal/privacy, not SEO. See `legal.md`. Do not mark them PASS from a banner existing.
