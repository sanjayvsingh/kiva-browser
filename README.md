# Kiva Loan Finder

A single-page, read-only tool for finding Kiva loans to make, based on a lender's own history:

- **Familiar**: loans like the ones you already make (country, sector, activity)
- **New to us**: countries, sectors and activities you haven't lent to yet
- **Achievements**: loans that count toward Kiva badges you're close to the next tier of
- **Country coverage**: your loans per country next to what's fundraising now

Filters cover Kiva's regions (with an option to exclude G7 or G20 countries), women borrowers only, repayment term, default rate, % funded, amount left to fund, days left, and hiding loans you're already in. Searches can be saved by name, and the last few are remembered automatically.

## Use

Upload `index.html` and `app.js` together to any static web host (or run locally with `py -m http.server`; opening the file directly from disk won't load `app.js` under the page's security policy in all browsers).

- **Without a lender ID**, loans are ranked by urgency: nearly funded, little left to raise, or expiring soon.
- **With a lender ID** (the last part of `kiva.org/lender/<id>`; the lender page must be public), you also get the Familiar, New to us, Achievements and Country coverage views, ranked against your own history.

The lender ID, settings and saved searches stay in the visitor's browser.

## How it works

The page calls Kiva's public GraphQL API (`https://gateway.production.kiva.org/graphql`) directly from the browser. No API key, login or backend is needed, and nothing is sent anywhere else. Lending itself happens on kiva.org.

Downloads are cached in the browser's IndexedDB (loans for 15 minutes, portfolio and badges for an hour) because Kiva's firewall briefly blocks clients that send many requests in a short time. Use **Refresh** or **Load** for fresh data, e.g. right after making a loan.

## Security

The page is read-only and has no backend, accounts or secrets. It also:

- sets a Content-Security-Policy (in `index.html`) so only its own `app.js` can run, data can only be fetched from Kiva's API, and images only from kiva.org
- escapes all text from Kiva and from browser storage before display, and validates stored settings, saved searches and the `?lender=` parameter
- sends no referrer, so the page address (which can include `?lender=`) isn't passed to Kiva

A few protections can only come from the web server. If your host allows it, serve the page over HTTPS and add these headers. `frame-ancestors` prevents other sites from embedding the page (clickjacking), which a `<meta>` policy can't do.

Apache (`.htaccess`):

```apache
Header always set Content-Security-Policy "frame-ancestors 'none'"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "no-referrer"
```

nginx:

```nginx
add_header Content-Security-Policy "frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```

Settings, saved searches and cached loans live in the browser's storage for the site's origin. If other apps share the same origin (scheme + host + port), they could read or change that storage, so a dedicated subdomain is best.

## Related

- [KivaLens](https://www.kivalens.org) ([source](https://github.com/nuclearspike/kivalens)): a much fuller Kiva loan search, with detailed filters, field partner research and portfolio balancing. This project is independent of it and uses none of its code.
