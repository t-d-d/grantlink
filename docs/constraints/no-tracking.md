# No tracking
Relevance: The page, site/**, the CloudFront distribution, its headers or logging, or adding any script, font, image or analytics to the page
Decision: The page sets no cookie, runs no script or analytics, loads nothing from another host, and CloudFront keeps no access logs.

Why: A visitor's visit is nobody's data. With no cookie and no tracking the
page needs no cookie banner, and with no access logs there is no record of
who read it to keep, secure or delete.

## Rules

- The distribution has no `Logging` block, no real-time log config and no
  log delivery.
- No file in `site/` carries a script or sets a cookie.
- No file in `site/` loads anything from another host: no font, style,
  image or script. Links a reader follows are fine.
- CloudFront sends a content security policy that starts from
  `default-src 'none'`, allows only `'self'`, and allows no script.
- After each deploy, the live tier reads the page and each file it loads,
  and fails the deploy if any sets a cookie or loads from another host.

## Do not

- Load Inter or Space Grotesk from Google Fonts. It tells Google about
  every visit. Ship the font files from the page's own host if the system
  fonts will not do.
- Add analytics, even cookieless ones. The PRD says the page runs none.
- Turn on CloudFront access logs to debug. Read CloudFront's own metrics
  instead.

## Judgment

The checks read `site/` and the deployed page. A script injected some
other way, such as by a CloudFront function, is for review.

History: #1
