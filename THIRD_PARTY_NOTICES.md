# Third-party notices

## Hermes Agent (MIT)

The iLink protocol implementation and edge-case handling were adapted from / informed by Nous Research's Hermes Agent:

- Repository: https://github.com/NousResearch/hermes-agent
- Reference commit: 7bda2a3368024f7ae1c70cef16583e7c2c891674
- Adapter: https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/platforms/weixin.py
- Documentation: https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/website/docs/user-guide/messaging/weixin.md

This project reimplements the text transport in TypeScript and uses Pocket's existing session runtime. It does not bundle or execute Hermes. QR endpoints, headers, version fields, long polling, context tokens, and stale-session handling come from that reference, not a separately verified Tencent SDK contract. Defaults are taken from the implementation when its prose differs (2000-character adapter ceiling, 1.5-second pacing, fail-closed access).

The reference's license follows:

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pi Pocket

HTTP request/response contracts were checked against Pi Pocket 0.13.2 at de612d5622cdc66b6b8b4900c650c6f2efdf4c63. This bridge does not bundle Pocket. Its optional integration test invokes the user's separate source checkout with temporary data and a scripted model.

## npm dependencies

Runtime dependencies are qrcode (MIT), proper-lockfile (MIT), and zod (MIT). See their installed LICENSE files and package-lock.json for exact versions. No account credentials or third-party runtime data are distributed.
