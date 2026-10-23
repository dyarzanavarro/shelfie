# Shelfie

A lean, modern ebook library for Windows: a friendlier alternative to eBook mgtm software that does the three things most people need.

- **Library**: drop in EPUB, MOBI, AZW3 and PDF files (or whole folders, including an existing library). Shelfie reads titles, authors, series and covers, and keeps duplicates out.
- **Convert**: turn MOBI/AZW3 into EPUB, entirely built in.
- **Kindle**: plug your Kindle in with a USB cable and copy books straight onto it, or set up Send to Kindle to deliver books over Wi-Fi by email.

## Download

Grab **Shelfie-Setup.exe** from the [latest release](../../releases/latest), run it, and Shelfie opens. It installs just for you; no admin rights needed.

> Windows may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

Your library is kept in `Documents\Shelfie Library`.

## Development

```bash
npm install
npm run dev       # run the app with hot reload
npm run dist      # build dist/Shelfie-Setup.exe
```

Built with Electron, React, TypeScript and SQLite.
