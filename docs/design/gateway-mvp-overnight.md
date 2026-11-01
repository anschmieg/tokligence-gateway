# Autonomous gateway MVP handoff — November1/2

User explicitly grants blanket authorization for reasonably beneficial actions with reasonably low unintended-side-effect risk, asks scheduling/automation until completion, and will be unavailable overnight. Target morning: November2 09:00 CET (08:00 UTC), an explicit planning assumption. This supersedes routine approval requirements in earlier project plans; platform policy still applies. Do not request another blanket approval.

## Before every next step

Read this checkpoint, the latest main plan/runbook and git status. Reassess original goal: reduce custom gateway maintenance through mainline router-for-me/CLIProxyAPI, native admin dashboard/API directly usable by T3 hubs, provider/plugin-level extensions. Prefer finishing useful routes and staged integration over more planning or generic tests. State what is actually usable and the one highest-value remaining gap. Do not lower acceptance silently to call an incomplete provider complete.

## Current state

Parent worktree /home/t3/.t3/worktrees/tokligence/fix-opencode-native-review, branch fix/opencode-native-review. Many unrelated/pre-existing native/opencode edits remain uncommitted: preserve them. No root checkout changes. Latest parent81b4940; Cline plugin auth/nonstream ports and stream parser/transport are integrated but undeployed. Existing source/diff evidence in prior plan and review.

VPS via ssh -F /home/t3/.ssh/fra-agent.conf fra-agent. New staging /home/agent/cliproxy-staging, native8.0.49 + dashboard1.27.0 verified and running loopback4195, empty provider/auth state. Bootstrap/lifecycle under staging/cli-proxy-api/. Quick smoke already passed; don't repeat core matrices. Provider templates and migration map exist; historical free-model IDs need catalog validation before use. Native dashboard/T3 external connectivity remains unverified.

Existing OpenCode staging /home/agent/tokligence-staging worker4187/gateway4190 is separate. Secondary OAuth exclusively owns refresh there; primary production untouched. Never copy/reseed live OAuth DB or restore /data/tokligence/zen/secondary-oauth.json, create second refresh owner or change account/IP/auth lane to compensate for rejection. Private env/key files never printed. One unplanned Cline fake-token external call occurred during child test and is documented; no successful live acceptance.

OpenCode last actual429 Nov1 10:10UTC, request01a19696-b57a-7399-bbb8-67cd26f7721d, resetNov2 00:00:00.756366UTC. Durable cooldowns/ledger take precedence; expiry alone does not schedule a probe. Earliest deliberate overnight OpenCode admission is01:03UTC with ready reviewed implementation and otherwise valid admission. Never replay old IDs/reports or automatic retries.

## Active delegates — completion wakes parent; do not poll

- Cline finalstreamwiring: task node:delegated-task:command%3Amcp%3A4e0ed033-7901-4ab0-855a-291be4bf4649%3Adelegate-task%3A7c5863f0-7816-4064-ac49-d87ad9c2f077. Ownplugins/cline.
- OpenCode persistent sessions: task node:delegated-task:command%3Amcp%3A4e0ed033-7901-4ab0-855a-291be4bf4649%3Adelegate-task%3Aa15e69cd-dd9e-4282-bd2f-e068d6b87b0b. Ownplugins/opencode. Candidatef30baed remains outsideparent, undeployed.

Do not duplicate running work, send review prompts to old children or poll task_status/threads for progress. Completion events trigger parent validation. Scheduled ticks do independent integration/configuration/deployment work or reassess blockers; if only delegate work remains, end without creating another watcher. New reviews get new delegate_task, small fixes parent handles.

## Execution and review

Use ONLY mistral/zai-glm-5-3-flash or mistral/mistral-small-latest through an available non-Codex provider. StandardGLM5.3 is prohibited. No Codex implementation children, no unasked provider/model fallback after failure. Isolated worktrees, short briefs/fileownership, incremental commits. Max three nonoverlapping implementation children; parent owns integration and staging. Upstream code gets quick smoke; custom code gets focused meaningful tests. Reject placeholders, fabricated parity and fake-success paths. Bound retries of failed agent calls; preserve work and narrow task or take a small fix directly rather than looping504s.

Use full-access runtimeMode where the tool permits (never broader than parent). Flat explicit commands; nontrivial logic in inspectable temporary scripts, exact owned paths, no broad cleanup or nested shell constructs. Child must leave a script/patch when execution is gated. Parent can execute already-authorized safe operations directly with its permitted tools after reviewing them. No impersonating user approval or hiding/splitting an action to evade review. If a platform-only human gate persists, record it and continue independent work; no overnight dependency on user response. Do not create a new supervisor framework or weaken system controls.

## MVP priorities

1. Native staging dashboard/API reachable by intended authorized operator/T3 route with protected management; discover actual T3 contract just in time. No custom dashboard/mandatory facade.
2. Configure useful supported providers through nativeconfig before customcode; obtain needed secrets through existing authorized secret delivery, never chat/dumps. API keys may be provisioned only when ownership/entitlement is clear; OAuth ownership handoffs must be sequential and verified. Missing credentials block only that route.
3. Finish and integrate Cline streaming and native-plugin registration with fake fixture/blocked external network, then real credential handoff only if owner safe. OpenCode plugin must own persistent sessions using pinned native identifier logic, not borrow manual IDs; preserve reasoning/tools and correct terminal outcomes. Narrow ports tracked to source; no fabricated complete harness parity.
4. One controlled live inference per provider AFTER implementation/review. A second only if helpful to diagnose failure; physical dispatches count. No fanout/background probes or implicit retries. Auth/quota rejection stops that provider until an explicitly valid later admission; uncertainty/timeouts stop further traffic. No paid fallback/new spend, IP/account rotation or quota reset consumption. Record provider/model/authmode/time/result/status/requestID/reset and dispatch count without private content. Existing operator manual successes are evidence, not gateway acceptance.
5. Deploy exact reviewed commits staging; keep services owned/logsprivate, preserve config and current cooldowns. Blanket approval allows low-risk production promotion only after a concrete useful replacement is verified, rollback/credential ownership are safe and effects known. Default overnight work stays staging; don't disturb functioning production routes to meet the clock.

## Automation and stopping

Recurring supervisor every15min in parent thread; not a model-inference timer, not a delegate poller. Update this checkpoint after meaningful integration/outcome and preserve reports. Disable the supervisor on fullcompletion or precise external blocker with no useful authorized work left. At08:00UTC produce a truthful morning report: available endpoints/routes, changed commits, live results, blockers and remaining custom gaps. If incomplete and useful safe work remains, continue within user authorization; deadline isn't permission to overclaim or risk accounts. No unchanged-status spam or generic repeated adversarial reviews.

Supervisor task: `scheduled-task:a9167950-84a6-47cf-89d6-f17c08b176c0`, interval900000ms, next initial run2026-11-01T20:49:18.969UTC. Historical four project schedules confirmed disabled. Use schedule_task(scheduledTaskId=..., enabled=false) to stop this supervisor at completion/blocker; do not create duplicate schedules.
