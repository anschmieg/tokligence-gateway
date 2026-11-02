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

Login-failure follow-up: initial production team was an old placeholder while
preview had the right team. Inspect production/runtime values separately; never
merge preview values when validating production. Global401 now calls local
invalidateSession only; explicit user Logout alone calls Access logout. The
error page retries /dashboard without revoking the SSO session. Regression
case drives the real unauthorized event handler; five focused tests pass.


Sidebar resource follow-up: the Access-only `/admin` API base must not prefix
native `/v0/resource/plugins/` URLs. `resolvePluginAssetURL` now resolves those
paths at the origin root on the Access host. FreeHub's static resource then
redirects into its existing authenticated `/admin/v0/management/.../console`.
Other deployments retain their configured mount prefixes. Three focused URL
regressions and all five Access-login cases pass; the panel builds successfully.
This does not expand backend aliases, weaken authentication or add browser keys.
