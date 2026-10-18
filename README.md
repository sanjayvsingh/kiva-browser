# Kiva Loan Finder

A single-page, read-only tool for finding Kiva loans to make, based on a lender's own history:

- **Familiar**: loans like the ones you already make (country, sector, activity)
- **New to us**: countries, sectors and activities you haven't lent to yet
- **Achievements**: loans that count toward Kiva badges you're close to the next tier of
- **Country coverage**: your loans per country next to what's fundraising now

Filters cover Kiva's regions (with an option to exclude the U.S. and Canada), women borrowers only, repayment term, default rate, % funded, amount left to fund, days left, and hiding loans you're already in. Searches can be saved by name, and the last few are remembered automatically.

## Use

Open `index.html` from any static web host (or locally with `py -m http.server`).

- **Without a lender ID**, loans are ranked by urgency: nearly funded, little left to raise, or expiring soon.
- **With a lender ID** (the last part of `kiva.org/lender/<id>`; the lender page must be public), you also get the Familiar, New to us, Achievements and Country coverage views, ranked against your own history.

The lender ID, settings and saved searches stay in the visitor's browser.

## How it works

The page calls Kiva's public GraphQL API (`https://gateway.production.kiva.org/graphql`) directly from the browser. No API key, login or backend is needed, and nothing is sent anywhere else. Lending itself happens on kiva.org.

Downloads are cached in the browser's IndexedDB (loans for 15 minutes, portfolio and badges for an hour) because Kiva's firewall briefly blocks clients that send many requests in a short time. Use **Refresh** or **Load** for fresh data, e.g. right after making a loan.

## Related

- [KivaLens](https://www.kivalens.org) ([source](https://github.com/nuclearspike/kivalens)): a much fuller Kiva loan search, with detailed filters, field partner research and portfolio balancing. This project is independent of it and uses none of its code.
