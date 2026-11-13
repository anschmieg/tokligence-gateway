// Synthetic-only bootstrap, run inside the network-isolated reference fixture.
import { Effect } from "effect"
import { EmbeddedHost } from "./internal/host"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/schema/integration"
const state = "/work/state"
const server = process.argv[2]
const endpoint = new URL(server)
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/console' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Synthetic loopback Console required')
const host = await Effect.runPromise(EmbeddedHost.create({
  app: { name: "cli", version: "2.1.4", channel: "latest" },
  database: { path: state + "/opencode.db" },
  config: { directory: state + "/config", project: false, claude: false },
  models: { fetch: false }, fs: { filewatcher: false, fff: false },
  log: { level: "error", emit: () => {} },
}))
try {
  await host.runtime.runPromise(Effect.gen(function* () {
    const credentials = yield* Credential.Service
    if ((yield* credentials.list(Integration.ID.make("opencode"))).length) throw new Error("Fixture database must be fresh")
    yield* credentials.create({ integrationID: Integration.ID.make("opencode"), activate: true,
      value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("device"),
        access: "synthetic-expired-access", refresh: "synthetic-refresh-canary", expires: 0,
        metadata: { server, orgID: "synthetic-org", orgName: "Synthetic" },
      }),
    })
  }))
} finally { await host.close() }
