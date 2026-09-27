#!/usr/bin/env python3
"""Unit tests for the catalog watchdog decision logic (stdlib only).

Run:  python3 tools/test_catalog_watchdog.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import catalog_watchdog as cw


ROUTES = """\
version: 1

providers:
  - id: codex-oauth
    adapter: oauth-proxy
    models:
      - id: gpt-5.6-luna
        context_window: 1050000
      - id: gpt-5.6-terra
        context_window: 1050000
      - id: gpt-5.6-sol
        context_window: 1050000
  - id: cline-oauth
    adapter: cline-oauth
    discover_models: true
    models: []

profiles:
  agent-default:
    context_window: 128000
    candidates:
      - provider: cline-oauth
        model: cline/cline-free/deepseek-v4-flash
      - provider: codex-oauth
        model: gpt-5.6-luna
  free-pool:
    candidates:
      - provider: cline-oauth
        model: cline/cline-free/deepseek-v4-flash

aliases:
  - id: profile-medium
    patterns: [medium]
    provider: codex-oauth
    target: gpt-5.6-luna
    fallback: profile-low
  - id: profile-low
    patterns: [low]
    provider: mistral
    target: ministral-8b-latest
"""

FIXTURE = """\
test("agent profiles preserve deterministic candidate order", () => {
  assert.deepEqual(profileByModel(config, "agent-default").candidates, [
    { provider: "cline-oauth", model: "cline/cline-free/deepseek-v4-flash" },
    { provider: "codex-oauth", model: "gpt-5.6-luna" },
  ]);
});
"""

ROUTES2 = """\
version: 1

providers:
  - id: codex-oauth
    adapter: oauth-proxy
    models:
      - id: gpt-5.6-terra
        context_window: 1050000
  - id: tokligence
    adapter: tokligence
    models: [minimax-m2.1, minimax-m2.5, minimax-m2.7]

profiles:
  agent-default:
    candidates:
      - provider: codex-oauth
        model: gpt-5.6-luna

aliases:
  - id: profile-medium
    provider: codex-oauth
    target: gpt-5.6-luna
"""


def catalogs(**kw):
    base = {
        "cline-oauth": {"cline/cline-free/deepseek-v4-flash"},
        "codex-oauth": {"gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"},
    }
    base.update(kw)
    return base


class ExtractDeclaredTests(unittest.TestCase):
    def test_extracts_candidates_provider_models_and_alias_targets(self):
        refs = cw.extract_declared(ROUTES)
        candidates = [r for r in refs if r.kind == "candidate"]
        provider_models = [r for r in refs if r.kind == "provider_model"]
        alias_targets = [r for r in refs if r.kind == "alias_target"]
        self.assertIn(("cline-oauth", "cline/cline-free/deepseek-v4-flash"),
                      {(r.provider, r.model) for r in candidates})
        self.assertIn(("codex-oauth", "gpt-5.6-luna"),
                      {(r.provider, r.model) for r in candidates})
        self.assertIn(("codex-oauth", "gpt-5.6-luna"),
                      {(r.provider, r.model) for r in provider_models})
        self.assertIn(("codex-oauth", "gpt-5.6-luna"),
                      {(r.provider, r.model) for r in alias_targets})


class FamilyTests(unittest.TestCase):
    def test_version_bump_matches(self):
        self.assertTrue(cw.same_family("cline/cline-free/deepseek-v4-flash",
                                       "cline/cline-free/deepseek-v4.1-flash"))
        self.assertTrue(cw.same_family("gpt-5.6-luna", "gpt-6-luna"))

    def test_different_model_rejected(self):
        self.assertFalse(cw.same_family("gpt-5.6-luna", "gpt-6-terra"))
        self.assertFalse(cw.same_family("cline/cline-free/mimo-v2.6-flash",
                                        "cline/cline-free/gemini-3.8-flash"))

    def test_unrelated_names_rejected(self):
        self.assertFalse(cw.same_family("deepseek-v4-flash", "llama-3.3-70b"))


class ClassifyTests(unittest.TestCase):
    def test_missing_model_with_unique_family_replacement_renames(self):
        cat = catalogs(**{"cline-oauth": {"cline/cline-free/deepseek-v4.1-flash"}})
        renames, asks = cw.classify_changes(ROUTES, cat)
        self.assertEqual([(r.old, r.new) for r in renames],
                         [("cline/cline-free/deepseek-v4-flash",
                           "cline/cline-free/deepseek-v4.1-flash")])
        self.assertEqual(asks, [])

    def test_supersession_with_higher_version_preferred(self):
        cat = catalogs(**{"codex-oauth": {"gpt-6-luna", "gpt-5.6-terra", "gpt-5.5-luna"}})
        renames, asks = cw.classify_changes(ROUTES, cat)
        self.assertEqual([(r.old, r.new) for r in renames],
                         [("gpt-5.6-luna", "gpt-6-luna")])

    def test_unrelated_successors_ask(self):
        cat = catalogs(**{"cline-oauth": {"cline/cline-free/alpha-x",
                                          "cline/cline-free/beta-y"}})
        renames, asks = cw.classify_changes(ROUTES, cat)
        self.assertEqual(renames, [])
        self.assertEqual(len(asks), 1)
        self.assertEqual(asks[0].old, "cline/cline-free/deepseek-v4-flash")
        self.assertEqual(asks[0].options, [])

    def test_no_replacement_asks(self):
        cat = catalogs(**{"cline-oauth": set()})
        renames, asks = cw.classify_changes(ROUTES, cat)
        self.assertEqual(renames, [])
        self.assertEqual(len(asks), 1)
        self.assertEqual(asks[0].options, [])

    def test_alias_fallbacks_are_not_model_refs(self):
        # fallback: profile-low points at another alias and must not be
        # classified as a codex model reference.
        cat = catalogs(**{"codex-oauth": {"gpt-6-luna", "gpt-5.6-terra"}})
        renames, asks = cw.classify_changes(ROUTES, cat)
        self.assertEqual([a.old for a in asks if a.old == "profile-low"], [])

    def test_healthy_catalog_is_a_noop(self):
        renames, asks = cw.classify_changes(ROUTES, catalogs())
        self.assertEqual((renames, asks), ([], []))


class ApplyTests(unittest.TestCase):
    def setUp(self):
        cat = catalogs(**{
            "cline-oauth": {"cline/cline-free/deepseek-v4.1-flash"},
            "codex-oauth": {"gpt-5.6-luna", "gpt-5.6-terra"},
        })
        self.renames, _ = cw.classify_changes(ROUTES, cat)

    def test_applies_across_routes_and_fixtures(self):
        routes, fixtures = cw.apply_renames(ROUTES, {"test/agent-profile.test.mjs": FIXTURE}, self.renames)
        self.assertNotIn("cline/cline-free/deepseek-v4-flash", routes)
        self.assertIn("cline/cline-free/deepseek-v4.1-flash", routes)
        self.assertIn("cline/cline-free/deepseek-v4.1-flash", fixtures["test/agent-profile.test.mjs"])
        self.assertNotIn("cline/cline-free/deepseek-v4-flash", fixtures["test/agent-profile.test.mjs"])

    def test_inserts_into_explicit_provider_models_list(self):
        cat = catalogs(**{"codex-oauth": {"gpt-6-luna", "gpt-5.6-terra"},
                          "cline-oauth": {"cline/cline-free/deepseek-v4-flash"}})
        renames, _ = cw.classify_changes(ROUTES, cat)
        routes, _ = cw.apply_renames(ROUTES, {}, renames)
        # new codex model added to the provider's explicit models list...
        self.assertIn("      - id: gpt-6-luna", routes)
        # ...and references in profiles/aliases repointed
        self.assertIn("model: gpt-6-luna", routes)
        self.assertIn("target: gpt-6-luna", routes)
        self.assertNotIn("gpt-5.6-luna", routes)

    def test_idempotent(self):
        routes, fixtures = cw.apply_renames(ROUTES, {"f": FIXTURE}, self.renames)
        cat = catalogs(**{"cline-oauth": {"cline/cline-free/deepseek-v4.1-flash"},
                          "codex-oauth": {"gpt-5.6-luna", "gpt-5.6-terra"}})
        renames2, _ = cw.classify_changes(routes, cat)
        # codex still declares gpt-5.6-luna in this synthetic case (no rename was
        # requested for it), so only the cline rename must be already applied.
        self.assertEqual([(r.old, r.new) for r in renames2], [])
        routes2, _ = cw.apply_renames(routes, {"f": fixtures["f"]}, renames2)
        self.assertEqual(routes2, routes)

    def test_no_partial_edits_on_unknown_rename(self):
        bogus = [cw.Rename(old="cline/cline-free/deepseek-v4-flash",
                           new="cline/cline-free/does-not-exist",
                           provider="cline-oauth", reason="test")]
        with self.assertRaises(ValueError):
            cw.apply_renames(ROUTES, {}, bogus,
                             catalogs={"cline-oauth": {"cline/cline-free/deepseek-v4.1-flash"}})


class InsertionTests(unittest.TestCase):
    def test_inserts_when_old_absent_from_models_list(self):
        # gpt-5.6-luna referenced only via profile candidate + alias target,
        # so the rename must ALSO add it to codex-oauth's explicit models list.
        cat = catalogs(**{"codex-oauth": {"gpt-6-luna", "gpt-5.6-terra"}})
        renames, _ = cw.classify_changes(ROUTES2, cat)
        self.assertEqual([(r.old, r.new) for r in renames], [("gpt-5.6-luna", "gpt-6-luna")])
        routes, _ = cw.apply_renames(ROUTES2, {}, renames)
        self.assertIn("      - id: gpt-6-luna", routes)
        self.assertIn("model: gpt-6-luna", routes)
        self.assertIn("target: gpt-6-luna", routes)
        self.assertNotIn("gpt-5.6-luna", routes)

    def test_inline_models_list_extracted(self):
        refs = cw.extract_declared(ROUTES2)
        inline = {(r.provider, r.model) for r in refs if r.kind == "provider_model"}
        self.assertIn(("tokligence", "minimax-m2.5"), inline)
        self.assertIn(("codex-oauth", "gpt-5.6-terra"), inline)


CODEX_CATALOG = {"codex-auto-review", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol",
                 "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol",
                 "gpt-image-1.5", "gpt-image-2"}


class CodexTests(unittest.TestCase):
    def test_codex_served_models_are_noop(self):
        renames, asks = cw.classify_changes(ROUTES, {"codex-oauth": CODEX_CATALOG})
        self.assertEqual((renames, asks), ([], []))

    def test_codex_supersession_when_retired(self):
        catalog = CODEX_CATALOG - {"gpt-5.6-sol"}
        renames, _ = cw.classify_changes(ROUTES, {"codex-oauth": catalog})
        self.assertEqual([(r.old, r.new) for r in renames],
                         [("gpt-5.6-sol", "gpt-6-sol")])

    def test_codex_unrelated_models_do_not_match(self):
        catalog = CODEX_CATALOG - {"gpt-5.6-luna", "gpt-6-luna"}
        renames, asks = cw.classify_changes(ROUTES, {"codex-oauth": catalog})
        # with no luna-family model served, there is no verifiable successor:
        # queued for approval instead of renamed.
        self.assertEqual([r.old for r in renames if r.old == "gpt-5.6-luna"], [])
        self.assertIn("gpt-5.6-luna", [a.old for a in asks])


class ApprovalTests(unittest.TestCase):
    def test_approval_consumes_pending_ask(self):
        asks = [cw.Ask(old="m-old", provider="cline-oauth",
                       options=["a-new", "b-new"], reason="ambiguous")]
        renames = cw.approve(asks, "m-old=a-new")
        self.assertEqual([(r.old, r.new) for r in renames], [("m-old", "a-new")])

    def test_approval_rejects_unknown_option(self):
        asks = [cw.Ask(old="m-old", provider="cline-oauth",
                       options=["a-new"], reason="ambiguous")]
        with self.assertRaises(ValueError):
            cw.approve(asks, "m-old=c-new")


if __name__ == "__main__":
    unittest.main(verbosity=2)