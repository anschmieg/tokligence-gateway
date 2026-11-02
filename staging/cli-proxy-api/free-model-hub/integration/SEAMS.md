# Native integration seams

The console registers an authenticated plugin management route:
`GET /v0/management/plugins/free-model-hub/console`.
The deployed native alias already supports it at
`/admin/v0/management/plugins/free-model-hub/console`.
No backend alias extension or authentication proxy is needed. The public static
resource page redirects to this protected management route in keyless mode.

Management authentication remains the native middleware: a verified Cloudflare
Access assertion, or the existing native management key for trusted API clients.
The keyless console reads/sends no browser management key and never persists one.
A rejected session stops requests and directs the operator to `/dashboard`;
it never logs out Cloudflare automatically or asks for a Management Key.

The plugin and host HTTP clients BOTH reject automatic redirects. The plugin
uses CheckRedirect in its hostbridge clients; the existing host provider-scoped
redirect guard includes `freehub` in native build8.0.49-tokligence.5. This small
host seam is necessary because the pinned SDK exposes no redirect control and
otherwise follows redirects before the plugin can inspect a response. It adds
no process or separate proxy. Other host behavior and native APIs stay intact.

Use an empty allowed-vendors list with `blocked_vendors` set to
`opencodezen,opencodego,openrouter`. All other compiled login/API-key providers
remain available. Kilo is the only remaining keyless provider; enabling keyless
provisioning creates only its public account. No OAuth data is imported/copied,
no OpenCode public lane is activated, and the plugin keepalive scheduler is off.
Native host refresh owns plugin credentials. Model aliases use upstream's
provider-prefix setting to avoid accidentally replacing existing native routes.

Provider support is not proof of free entitlement or live inference acceptance.
No previously passed provider test is repeated, and OpenCode cooldown remains
binding across reconnects and plugins. A real provider call needs the existing
bounded admission and an actual eligible model/account.
