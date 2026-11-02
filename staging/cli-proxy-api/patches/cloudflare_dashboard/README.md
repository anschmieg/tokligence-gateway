# Native panel Access bootstrap

Parent-recovered after delegated504. Applies only to pinned native dashboard1.27.0
source4e4aeff23f9f82b3ccdbe48b2e774d5dc918234e and only browser host
code.nothing.pink/HTTPS. Successful same-origin management config fetch with an
empty key establishes auth; no fake management key, foreignapiBase or persistence.
The backend separately validates signed Access assertions. Otherhosts retain
native keylogin. Build/typecheck passed with frozen bun.lock; actual personal
Cloudflare browser login is pending deployment and Google's preview-browser block.

Focused parent verification: copy access_login.test.ts into prepared tree
`tests/`, run `bun test tests/access_login.test.ts`, then `bun run build`.
Tests stay outside upstreamsrc/typecheck inclusion; no changes to upstream
compiler settings or broad core tests. Four custom authentication-state cases
passed with fake config API and no provider/network calls.
