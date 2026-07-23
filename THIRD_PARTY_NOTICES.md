# Third-party notices

This repository includes or interacts with third-party software and services.
Project publication does not replace their licences or terms.

## Vendored browser software

### React and React DOM 18.3.1

Files:

- `public/vendor/react.production.min.js`
- `public/vendor/react-dom.production.min.js`

Source: <https://github.com/facebook/react/tree/v18.3.1>

Copyright (c) Facebook, Inc. and its affiliates.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Babel Standalone 7.26.4

File: `public/vendor/babel.min.js`

Source: <https://github.com/babel/babel/tree/v7.26.4>

Copyright (c) 2014-present Sebastian McKenzie and other contributors

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Claude Design export and generated runtime

`public/Sweepstake.dc.html` originated as a Claude Design export and has since
been modified by project contributors. The repository's MIT License applies to
the contributors' rights in that exported application code and design.

`public/support.js` is the generated `dc-runtime` bundle supplied with that
export. The TypeScript source tree named in its header is not included, and no
separate runtime licence accompanied the exported files. `public/support.js`
is excluded from the repository's MIT License, and this repository grants no
licence for that file. Use and redistribution remain subject to the terms
governing the original Claude Design export.

See the [Claude Design export
documentation](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
and Anthropic's [Consumer
Terms](https://www.anthropic.com/legal/consumer-terms) or [Commercial
Terms](https://www.anthropic.com/legal/commercial-terms), as applicable.

## Runtime services and content

- Google Fonts supplies Barlow and Barlow Condensed at runtime.
- API-Football, Guardian Open Platform, BBC Sport, Railway, Resend, and
  Cloudflare remain subject to their own service, data, branding, and content
  terms.

No provider grants rights to another provider's content, competition data, or
trademarks merely because this source code is available.
