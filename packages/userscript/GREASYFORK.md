# GreasyFork listing metadata stub

Status: draft only. No upload or publication has occurred.

- Name: Interlinear Reader — In-page glosses
- Name (zh-CN): 行间阅读器 — 网页逐词注释
- Description (en): Add short Chinese glosses beneath Japanese and English article words. Dictionary first; optional OpenAI-compatible backfill with your key and explicit consent.
- Description (zh-CN): 为日语和英语网页正文添加行间中文词义。优先查词典；可选自备 OpenAI 兼容 API 密钥，并明确同意后补全缺词。
- Version: 0.1.0
- Code license / header: `@license MIT`
- Feedback URL: `https://github.com/<OWNER>/<REPO>/issues` — replace before publication.
- Homepage: `https://github.com/<OWNER>/<REPO>/tree/main/packages/userscript` — replace before publication.
- Install URL: `<GREASYFORK_LISTING_URL>` — fill after manual publication.
- Code file: `dist/interlinear-reader.user.js`

## Listing body draft

Click **文 / Annotate** to add Chinese word glosses to article text. Click **↩ Restore** to restore the page. Japanese and English are supported; Japanese dictionary coverage is limited. Unknown words stay blank by default.

Optional LLM backfill uses your provider endpoint, model, and API key. Configure them through the Tampermonkey menu. By default the key is remembered in GM script storage on disk (with a masked display and last-updated time); the menu toggle 仅本次会话（不保存） keeps it memory-only instead. GM storage is plaintext in your browser profile — no userscript can defend it against local malware — so use a dedicated low-balance key with hard usage/spend limits set in your provider console (OpenAI Usage limits / 项目限额, Anthropic Spend limits, or the equivalent for DeepSeek, Moonshot and others), rotate it, and revoke it on suspicion. Before sending article text, the script asks for consent for that site and endpoint. The provider may retain text and charge your account.

The broad `@match` makes this script eligible on many sites. Restrict included sites in Tampermonkey before enabling it. The wildcard `@connect` supports user-selected provider hosts; narrow it to your provider where possible. The fixed R2 dictionary host receives only dictionary-path requests. No remote JavaScript or WASM is executed.

No iframe coverage or mobile-manager guarantee. Strict CSP, manager sandboxes, and complex pages may prevent operation. The automated tests use an injected script with GM stubs, not a real Tampermonkey installation. Do not use this release on sensitive pages until its behavior has been checked in your manager/browser combination.

See the README for permissions, dictionary attribution, known license-verification notes, cache limits, privacy, and uninstall instructions. Disabling or removing the script in Tampermonkey stops future execution; use the erase-key menu before removal if you also want to clear its saved configuration.
