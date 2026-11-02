# rid-sdk-js-example

An example JS app showcasing the rid-sdk functionality.

**Retail ID SDK Explorer** is a local web app for trying the Metrc Retail ID
JavaScript SDK (`@metrc/retailid`, from
[rid-sdk/javascript](https://github.com/nathanhouse-metrc/rid-sdk/tree/main/javascript))
without writing code. It has the same tabs and features as the Python example
([rid-sdk-python-example](https://github.com/nathanhouse-metrc/rid-sdk-python-example)).
Each SDK feature has inputs, action buttons and a results panel.

| Tab | SDK feature |
| --- | --- |
| **Settings** | Enter and save `vendor_api_key`, `user_api_key`, `state_code` and `base_url`; *Test connection* calls `getFacilities()` |
| **Encode** | `getShortUrl(batchId, index, { domain, base64 })`: batch ID + index → Retail ID URL (base36 or base64, custom domain) |
| **Decode** | `new RetailIdPair(url, strict)` and `shortCodeFromUrl()`: URL or short code → batch ID + index, re-encoded both ways |
| **Access** | `getFacilities()` |
| **Label printing** | `getAllotment()`, `getAvailableTags()`, `getPackage()`, `getPackagesInfo()`, `generate()` |
| **Receiving** | `receive()`, `receiveByQr()`, `associatePackage()`, `merge()` |
| **Point of sale** | `postSales()` to any of the sales endpoints (`receipts`, `deliveries`, …) |
| **Catalog** | `getGlobalProducts()`, `getGlobalProduct()` |

Encode and Decode work offline. The API tabs use a `RetailIdClient` built from
the saved settings (with `loadConfig()` from `@metrc/retailid/node`), and share
one facility license number field. Calls that change data in Metrc (generate,
associate, merge, sales) have a red *Send (changes data)* button and ask for
confirmation first.

## How it works

The SDK's API client is **server-side only**: it carries your API keys and
refuses to run in a browser. So the app is two parts:

- `src/server.js`, a small Node server (no dependencies besides the SDK) that
  runs every SDK call. It listens on `127.0.0.1` only, answers only requests
  addressed to it, and only accepts JSON POSTs from its own page.
- `public/`, the page in your browser: inputs, buttons and results. It never
  sees the saved API keys, only a masked form (`••••••••1234`). To change a key,
  type a new one; leaving a key field blank keeps the saved key.

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer (the SDK's API client uses the
  built-in `fetch`).
- A local checkout of [rid-sdk](https://github.com/nathanhouse-metrc/rid-sdk)
  **next to this repository**, with the JavaScript SDK built:

  ```
  git/
  ├── rid-sdk/                ← SDK checkout
  │   └── javascript/         ← the @metrc/retailid package
  └── rid-sdk-js-example/     ← this repo
  ```

  The API tabs need the SDK's Retail ID API client (`@metrc/retailid/api`). If
  your rid-sdk checkout does not have `javascript/src/api/` yet, check out a
  branch that does (for example `main`).

## Install

The app depends on the SDK through the local checkout
(`"@metrc/retailid": "file:../rid-sdk/javascript"` in `package.json`), so SDK
changes are picked up after rebuilding the SDK, without reinstalling. If your
rid-sdk checkout lives elsewhere, edit that path.

Build the SDK once (and again after changing it):

```bash
cd ../rid-sdk/javascript
npm ci
npm run build
```

Then install this app:

```bash
cd rid-sdk-js-example
npm install
```

## Run

```bash
npm start
```

This starts the server at <http://127.0.0.1:8640/> and opens it in your default
browser. Use `npm start -- --no-open` to skip opening a browser, and set `PORT`
to use another port.

On first launch the app opens on **Settings**. Fill in your keys and either a
`state_code` (e.g. `md` → `https://api-md.metrc.com`) or a `base_url` (which
overrides the state code; use it for the Sandbox), then **Save** and **Test
connection**.

## Where settings are stored

Settings are saved to `settings.json` in the repository root, using the same
keys as the SDK's `config.json`, so the file also works with
`createClientFromConfigFile("settings.json")`, and with the Python example
app. Extra keys in the file (`timeout`, `max_retries`, `backoff_base`) are kept
and used. The app also remembers the last facility license number there.

`settings.json` holds your API keys and is listed in `.gitignore`; never commit
it. To keep it somewhere else, set `RID_EXAMPLE_SETTINGS` to a file path before
starting the app.

## Look and feel

Colours and fonts follow the Metrc design used in Metrc's shared prototypes and
the Python example (forest-green brand bar, warm off-white surfaces, Inter and
IBM Plex Mono); all of them are tokens at the top of `public/styles.css`. Inter
and IBM Plex Mono are used when installed (free from Google Fonts); otherwise
the app falls back to Segoe UI / Helvetica and Cascadia Mono / Consolas / Menlo.

## Differences from the Python example

- It is a local web app rather than a desktop window, because the JavaScript
  API client must not run in a browser.
- Saved API keys are write-only in the UI (see *How it works*); *Forget saved
  keys* removes them.
- Results show the JavaScript SDK's models, so fields are camelCase
  (`qrCount`, `issuanceId`) and `getAllotment()` returns a list.
- The JavaScript SDK encodes indexes from 0 to 4294967295.

## Tests

The tests drive every tab's server endpoint against the real SDK, with a local
fake of the Retail ID API, so they need no keys and change nothing in Metrc:

```bash
npm test
```

## Project layout

```
src/
├── server.js     local HTTP server: routes, settings, background SDK calls
├── codec.js      Encode and Decode
├── actions.js    API tabs; one action per RetailIdClient method
└── settings.js   load/save settings.json
public/
├── index.html    page shell
├── app.js        tabs, cards and the results panel
└── styles.css    colours, fonts and layout
test/app.test.js  end-to-end tests with a fake API server
```
