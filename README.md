# Price Lens

Point your phone's camera at a price tag. Price Lens reads the price and shows it in your currency at the current exchange rate.

It's a web app with no build step. Open it in Safari or Chrome on a phone and add it to the home screen, and it then works like an installed app, offline included.

## How it works

1. **Camera.** The back camera fills the screen and you aim the box at a price. **Scan** freezes the frame and reads it. **Live** keeps reading while you move the phone, and labels each price in place. **Photo** reads a picture you already have. **Type** converts a price you type in.
2. **Reading the text** (`src/reader.js`). [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)'s PP-OCRv6 tiny models run on the phone, in [ONNX Runtime Web](https://onnxruntime.ai) compiled to WebAssembly, so pictures never leave the device. One small neural network finds the lines of text in the picture; a second reads each line. They were trained on photos of signs, shelves and packaging, so they read price tags at an angle, in odd light or on coloured card far better than a reader made for scanned pages (see [Measuring](#measuring)).
   - The first scan downloads the reader: about 8.4 MB (19 MB once unpacked), with a progress figure on screen. After that it's stored on the phone, and works offline.
   - It reads in a background worker, so the screen keeps responding. A picture takes about half a second on a laptop; phones are slower.
   - It needs a recent browser: Safari 16.4 or later on an iPhone, a recent Chrome on Android. When it starts, it first reads a small picture of a known price, because some phones get the sums wrong (iOS 16.4 to 16.5.0 read garbage).
   - Where it can't start, can't be downloaded, fails that test or stops responding, [Tesseract](https://github.com/naptha/tesseract.js) reads instead, for the rest of the visit (about 4.4 MB, also stored on the phone). Settings then shows *Text reader: standard*, and why.
3. **Finding the price** (`src/prices.js`). This step handles:
   - currency signs before or after the number (`€12,50`, `12.50 CHF`, `1,980円`, `R$ 49,90`, `49:-`), plus ISO codes
   - thousands and decimal separators in every local style: `1,234.56`, `1.234,56`, `1 234,56`, `12'500`, `12,-`
   - currencies that have no cents (`¥1.980` is 1980)
   - common misreadings (O for 0, l for 1), and signs the reader gets wrong where that currency is the local one: `₹` read as `¥` or `X`, `円` as `M`, `zł` as `zi`, `Kč` as `K¢`, `฿` as `B`. A misread sign only counts next to a number that already looks like a whole price (`12,50 E` is euros, `12 E` and `5 M` are not)
   - pence and cents (`75p`, `79¢`), and cents split off by a space (`€17, 79`, or `17 19` as the biggest text)
   - weights, volumes, percentages, dates, times, article numbers, barcodes and counts ("80 bags"), which it skips
   - cents the reader could not make out (`98% zł`, `541°`, `€38,7`): rather than show the whole part as the price, it shows nothing, so you can move closer and try again

   A number with no currency sign has to look like money: cents in the local style, the biggest text on the tag, or, for currencies without cents such as yen, 10 or more. Numbers the reader wasn't sure of need a sign. When a tag shows several prices, the one in the biggest letters, nearest the middle of the box, comes first; a price per kilo or per 100 g comes after the price to pay. Tap another price to pick it instead.

   In **Live** mode a price appears only once it has been read in 2 of the last 4 frames, and the price shown big stays until it leaves the picture, so it doesn't jump between numbers as the camera moves.
4. **Which currency.** Tags that show no sign, or a shared sign (`$`, `¥`, `kr`), are read in the currency of the country you're in. On *Automatic*, the country comes from:
   - **your phone's time zone**, right away: phones change it by themselves when you land in a new country, and it needs no permission and no connection.
   - **GPS**, if you allow it (Settings → *Find my country with GPS*): more exact near borders, and right even if the clock hasn't changed. Only a rounded position (about 10 km) is sent to [BigDataCloud](https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api)'s free lookup to get the country. Once allowed, it's checked every time the app opens.

   The internet address is not used, because phones roaming abroad usually still show their home country. You can also pick the tag currency by hand. Signs that are also ordinary letters (`R`, `Ft`, `RM`, `kr`, `TL`…) and codes that are also English words (`ALL`, `TOP`, `PEN`) only count where that currency is the local one, so a stray letter can't switch the currency. So does `£`, which the reader also makes out of smudges.
5. **Exchange rates** (`src/rates.js`). Rates come from [ExchangeRate-API's open endpoint](https://www.exchangerate-api.com/docs/free), which covers about 160 currencies and updates daily. If that fails, they come from [Frankfurter](https://frankfurter.dev), which has the ECB reference rates. Neither source needs a key. Rates are fetched again once they're more than an hour old, and the last set is kept on the phone for offline use. Every result shows the rate it used and when that rate was published.

These are mid-market reference rates. What your card or a cash exchange actually charges will differ by its fee.

## Files

| File | What it does |
|---|---|
| `index.html` | The page: camera view, result panel, settings and "type a price" sheets |
| `src/app.js` | Camera, scanning, live mode, photos, labels on the picture, settings |
| `src/reader.js` | Picks the text reader: PaddleOCR where the phone can run it and it passes its test, Tesseract otherwise |
| `src/ocr-paddle.js` | The PaddleOCR reader as the page sees it: starts its worker once, hands it a snapshot of the part to read, gets the lines back |
| `src/paddle-worker.js` | The PaddleOCR reader itself, in a worker: loads ONNX Runtime and the models, finds the lines of text, cuts each out level and reads it |
| `src/paddle-boxes.js` | Its plain-JavaScript steps: boxes from the detector's map, letters from the recogniser's output, boxes joined into lines (tested on their own) |
| `src/ocr.js` | The standard reader: loads Tesseract, prepares the picture (crops, enlarges, evens out contrast, flips light-on-dark text) and reads lines |
| `src/prices.js` | Finds prices in the text (no page needed, so it's tested on its own) |
| `src/rates.js` | Fetches, caches and applies exchange rates |
| `src/location.js` | Which country the phone is in (time zone, or GPS) and its currency |
| `src/zones.js` | Time zone → country table, generated by `tools/make-zones.py` from the time zone database |
| `sw.js` | Offline copy of the app and the text reader |
| `test/` | `prices.test.mjs` and `paddle.test.mjs`: unit tests for the price reading and the reader's box geometry. `e2e.mjs`: a real browser fed price-tag pictures, both as a photo and as a fake camera, with the reader blocked, and offline |
| `bench/` | The benchmark: how often the app reads the right price (see [Measuring](#measuring)) |

## Run it

The camera and the offline copy only work from a secure address: `https://`, or `http://localhost` on a computer.

```
npx http-server -c-1 .        # then open http://localhost:8080
```

To use it on a phone, put the folder on any https host. Every path inside is relative, so a sub-folder works. Options include GitHub Pages, Netlify, Cloudflare Pages, or this repository's own GitHub Pages (Settings → Pages → Deploy from a branch, `main`, folder `/ (root)`), which serves it at `https://jorycook.github.io/price-lens/`. Then, on the phone:

- **iPhone:** open the address in Safari, tap Share, then Add to Home Screen.
- **Android:** open it in Chrome, open the menu, then tap Install app.

When you change a file, bump `VERSION` in `sw.js` so installed copies pick up the change.

## Tests

```
npm test            # price reading (separators, signs, things that aren't prices) and the reader's boxes
npm run e2e         # needs Playwright + Chromium and a connection
```

The end-to-end test also checks that the page never stops responding for 200 ms while the reader starts and reads, that the app falls back to Tesseract when PaddleOCR's files are blocked, and that after one visit it still reads with the network cut.

## Measuring

`bench/run.mjs` draws made-up price tags (in many styles, with camera blur, noise and JPEG damage), or takes your own photos, and reads each with the app's own code in headless Chromium. A tag counts as *right* when the first price the app offers is the tag's selling price, in the right currency.

```
node bench/run.mjs --engine paddle --synth 120 --seed 1        # 120 made-up tags, read by PaddleOCR (in its worker, as in the app)
node bench/run.mjs --synth 120 --seed 2                        # other tags, read by Tesseract
node bench/run.mjs --engine paddle --synth 0 --real photos/labels.json --out results.json
node bench/run.mjs --engine app                                # whichever reader the app picks
node bench/run.mjs --engine paddle --settings '{"boxThresh":0.4}'   # try other reader settings
```

`labels.json` lists your photos: `[{ "id", "file", "aim": [x0, y0, x1, y1], "main": { "amount", "currency" }, "others": [...] }]`, with `aim` the part of the photo inside the aiming box.

## Limits

- PaddleOCR's tiny model reads Latin letters with their accents, Greek, Chinese, digits and the signs € £ $ ¥ ₹ ₩ ₽ ₺ ₪ ₫ ₱. It has no Cyrillic, Japanese kana, Korean, Thai or Arabic letters, and no 円. Digits next to those scripts usually are read, and the tag-currency setting fills in the currency. The standard reader (Tesseract) reads only Latin letters, digits and € £ $ ¥.
- A tag held upside down is misread. Text turned on its side is read.
- On iPhones with iOS 16.4 to 17, opening and closing the app many times can leave too little memory for PaddleOCR to start (a WebKit bug with WebAssembly memory). The app then uses the standard reader until it is opened again.
- Small, curved, glossy or blurry tags read poorly. Move closer so the price fills the box, and avoid glare.
- Cents printed small and raised (4⁹⁹) may come out as 499, or as 4° (then no price is shown). Check against the original amount, which is always shown under the converted price.

## Credits and licences

- **PaddleOCR PP-OCRv6 tiny** detection and recognition models, by the [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) authors (PaddlePaddle), under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The app loads them, unchanged, as ONNX files from the npm package [`@arcships/light-ocr-model-ppocrv6-tiny`](https://www.npmjs.com/package/@arcships/light-ocr-model-ppocrv6-tiny) 0.1.0 by the light-ocr contributors ([repository](https://github.com/arcships/light-ocr)), also Apache-2.0, through jsDelivr. That package's NOTICE file reads:

  ```
  light-ocr
  Copyright 2026 light-ocr contributors

  This product includes software developed by the light-ocr contributors.

  Third-party licenses and notices for packaged dependencies and model
  artifacts are distributed with their respective release artifacts.
  ```

  and its model notice (`bundle/LICENSES/MODEL-NOTICE.md`), next to PaddleOCR's own licence text (`bundle/LICENSES/PaddleOCR-Apache-2.0.txt`):

  ```
  PP-OCRv6 tiny ONNX model bundle
  PaddleOCR revision: b03f46425e8ff4442b268ce449e3eef758146cd4
  Detection model revision: 2ba1506c0380b8f0b03dd142459aac66d4421f6c
  Recognition model revision: 2612ab37152ae0a677521bae4e1e3d4fb4cf7c30
  Sources: official PaddlePaddle model ecology archives listed in bundles.lock.json
  ```
- **ONNX Runtime Web** 1.24.3, by Microsoft, under the [MIT License](https://github.com/microsoft/onnxruntime/blob/v1.24.3/LICENSE). Its third-party notices: [ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/v1.24.3/ThirdPartyNotices.txt).
- **Tesseract.js** 5.1.1 and tesseract.js-core 5.1.1 (the standard reader), with the English model from `@tesseract.js-data/eng`, under the [Apache License 2.0](https://github.com/naptha/tesseract.js/blob/master/LICENSE).
