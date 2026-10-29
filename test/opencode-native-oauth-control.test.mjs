import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('native OAuth admission and quota persistence reject changed identity, auth and budgets', { timeout: 15000 }, async () => {
  await run('python3', ['test/opencode_oauth_comparison.py',
    'OAuthComparisonTests.test_native_reference_rejects_recovery_read_only_and_fails_closed_on_schema_drift',
    'OAuthComparisonTests.test_native_meter_phase_cap_and_safe_quota_persistence',
    'OAuthComparisonTests.test_native_reference_requires_free_available_text_catalog_before_inference',
    'OAuthComparisonTests.test_fixture_supervisor_reaps_detached_orphan_descendants',
    'OAuthComparisonTests.test_live_transaction_serializes_ownership_and_stops_before_second_request_on_failure',
    'OAuthComparisonTests.test_oauth_admission_rejects_public_old_versions_budget_changes_and_stale_evidence'], { timeout: 12000 });
});
test('actual native fetch accounting withholds tools and malformed control streams', { skip: !process.env.OPENCODE_NATIVE_BUN, timeout: 20000 }, async () => {
  await run('python3', ['test/opencode_oauth_comparison.py',
    'OAuthComparisonTests.test_native_fetch_preserves_requests_and_withholds_tool_or_invalid_control_responses',
    'OAuthComparisonTests.test_source_cli_recipe_disables_dotenv_and_bunfig_autoload',
    'OAuthComparisonTests.test_native_reference_inherits_lease_and_dies_with_driver'], { timeout: 18000 });
});
