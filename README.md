# Kiva Loan Finder

A single-page, read-only tool for finding Kiva loans to make, based on a lender's own history:

- **Familiar**: loans like the ones you already make (country, sector, activity)
- **New to us**: countries, sectors and activities you haven't lent to yet
- **Achievements**: loans that count toward Kiva badges you're close to the next tier of
- **Country coverage**: your loans per country next to what's fundraising now

Filters cover region (South America, Central America, Mexico & Caribbean, rest of world; the US and Canada are always excluded), women borrowers only, maximum repayment term, maximum default rate, and hiding loans you're already in.

## Use

Open `index.html` from any static web host (or locally with `py -m http.server`), enter a Kiva lender ID (the last part of `kiva.org/lender/<id>`) and press Load. The lender page must be public. The ID is saved only in the visitor's browser.

## How it works

The page calls Kiva's public GraphQL API (`https://gateway.production.kiva.org/graphql`) directly from the browser. No API key, login or backend is needed, and nothing is sent anywhere else. Lending itself happens on kiva.org.

Downloads are cached in the browser (loans for 15 minutes, portfolio and badges for an hour) because Kiva's firewall briefly blocks clients that send many requests in a short time. Use **Refresh** or **Load** for fresh data, e.g. right after making a loan.

## Related

- [KivaLens](https://www.kivalens.org) ([source](https://github.com/nuclearspike/kivalens)): a much fuller Kiva loan search, with detailed filters, field partner research and portfolio balancing. This project is independent of it and uses none of its code.
