// preferences.mjs — runtime routing-preference overrides for the dashboard.
//
// The routing policy in gateway.routes.yaml is the source of truth, but the
// dashboard lets an operator re-target capability profiles / aliases to a
// different provider+model and reorder fallback choices without restarting the
// process. This module owns:
//
//   * an in-memory override map (live, takes effect immediately),
//   * persistence to a sidecar YAML file (gateway.preferences.yaml) so
//     overrides survive a restart, and
//   * `bakeToRoutes()` — permanently writing overrides into the source-of-truth
//     gateway.routes.yaml so they are deployed on the next compile/restart, and
//   * an override-aware alias resolver that the proxy uses instead of the bare
//     route-config resolver.
//
// Overrides never expose secrets and apply only to aliases that already exist
// in the policy. Unknown alias ids are rejected at write time.
//
// shape of an override:
//   aliasId: {
//     provider: string,   // must be an enabled provider (or null = current)
//     target: string,     // resolved model id
//     fallback: string,   // next alias/model id, or null
//   }

import fs from "node:fs";
import { parse, parseDocument, stringify } from "yaml";

import { providerById, providerEnabled, resolveConfiguredAlias } from "./route-config.mjs";

const DEFAULT_PREFERENCES_PATH = "gateway.preferences.yaml";

export class RoutingPreferences {
  /**
   * @param {object} config   parsed routing config
   * @param {object} [opts]
   * @param {string} [opts.file]          sidecar path to persist overrides
   * @param {boolean} [opts.readonly]     never write to disk
   * @param {object} [opts.env]           env for providerEnabled checks
   */
  constructor(config, opts = {}) {
    this.config = config;
    this.file = opts.file || DEFAULT_PREFERENCES_PATH;
    this.routesPath = opts.routesPath || "gateway.routes.yaml";
    this.readonly = opts.readonly === true;
    this.env = opts.env || process.env;
    this.overrides = new Map(); // aliasId -> { provider, target, fallback }
    this._load();
  }

  _load() {
    if (this.readonly) return;
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = parse(fs.readFileSync(this.file, "utf8")) || {};
      for (const [id, value] of Object.entries(raw.aliases || {})) {
        if (!value || typeof value !== "object") continue;
        if (!this._aliasExists(id)) continue;
        this.overrides.set(id, {
          provider: value.provider ?? null,
          target: typeof value.target === "string" ? value.target : null,
          fallback: value.fallback ?? null,
        });
      }
    } catch (error) {
      console.warn(`preferences: failed to load ${this.file}: ${error.message}`);
    }
  }

  _aliasExists(id) {
    return this.config.aliases.some((alias) => alias.id === id);
  }

  enabledProvider(id) {
    const provider = providerById(this.config, id);
    return Boolean(provider && providerEnabled(provider, this.env));
  }

  get(id) {
    return this.overrides.get(id) || null;
  }

  list() {
    return Array.from(this.overrides.entries()).map(([id, o]) => ({ id, ...o }));
  }

  /**
   * Set or clear an override for one alias.
   * @returns {string[]} validation errors (empty when accepted)
   */
  set(id, override) {
    if (!this._aliasExists(id)) return [`unknown alias: ${id}`];
    if (!override) {
      this.overrides.delete(id);
      this._persist();
      return [];
    }
    const errors = [];
    if (override.provider != null && override.provider !== "" && !this.enabledProvider(override.provider)) {
      errors.push(`provider is not configured/enabled: ${override.provider}`);
    }
    if (typeof override.target !== "string" || !override.target.trim()) {
      errors.push("target must be a non-empty model id");
    }
    if (override.fallback != null && typeof override.fallback !== "string") {
      errors.push("fallback must be a string or null");
    }
    if (errors.length) return errors;
    this.overrides.set(id, {
      provider: override.provider || null,
      target: override.target.trim(),
      fallback: override.fallback || null,
    });
    this._persist();
    return [];
  }

  clear(id) {
    if (!this._aliasExists(id)) return [`unknown alias: ${id}`];
    this.overrides.delete(id);
    this._persist();
    return [];
  }

  reset() {
    this.overrides.clear();
    this._persist();
  }

  _persist() {
    if (this.readonly) return;
    const payload = {
      version: 1,
      description: "Runtime routing-preference overrides. Edited via the gateway dashboard.",
      aliases: Object.fromEntries(
        Array.from(this.overrides.entries()).map(([id, o]) => [id, {
          ...(o.provider ? { provider: o.provider } : {}),
          target: o.target,
          ...(o.fallback ? { fallback: o.fallback } : {}),
        }]),
      ),
    };
    fs.mkdirSync(this.file.split("/").slice(0, -1).filter(Boolean).join("/") || ".", { recursive: true });
    fs.writeFileSync(this.file, stringify(payload), { mode: 0o600 });
  }

  /**
   * Permanently write the current overrides into gateway.routes.yaml (the
   * source of truth). Each override sets the target alias's provider, target,
   * and fallback fields. After baking, the config now encodes these values, so
   * live overrides are cleared (they are redundant and would re-apply the same
   * values after a reload).
   *
   * @returns {{written: number, file: string, aliases: object[]}} summary
   */
  bakeToRoutes() {
    if (this.readonly) throw new Error("preferences are read-only");
    if (this.overrides.size === 0) {
      // Still rewrite nothing; just report no-op. Avoid touching the file.
      return { written: 0, file: this.routesPath, aliases: this.config.aliases };
    }
    // Use parseDocument (not parse) so comments and formatting survive the bake.
    const doc = parseDocument(fs.readFileSync(this.routesPath, "utf8"));
    const raw = doc.toJS();
    if (!Array.isArray(raw?.aliases)) throw new Error("gateway.routes.yaml has no aliases to bake into");
    let written = 0;
    for (const alias of raw.aliases) {
      const ov = this.overrides.get(alias?.id);
      if (!ov) continue;
      if (ov.provider) doc.setIn(["aliases", raw.aliases.indexOf(alias), "provider"], ov.provider);
      else if (ov.provider === null) doc.deleteIn(["aliases", raw.aliases.indexOf(alias), "provider"]);
      if (typeof ov.target === "string" && ov.target) {
        doc.setIn(["aliases", raw.aliases.indexOf(alias), "target"], ov.target);
      }
      if (ov.fallback) doc.setIn(["aliases", raw.aliases.indexOf(alias), "fallback"], ov.fallback);
      else if (ov.fallback === null) doc.deleteIn(["aliases", raw.aliases.indexOf(alias), "fallback"]);
      written += 1;
    }
    fs.writeFileSync(this.routesPath, doc.toString(), { mode: 0o600 });
    // Config now carries the baked values; drop the now-redundant live overrides.
    this.overrides.clear();
    this._persist();
    return { written, file: this.routesPath, aliases: this.config.aliases };
  }

  /**
   * Resolve a requested model to a concrete target, applying any override for
   * the matching alias. Mirrors route-config's resolveConfiguredAlias but lets
   * an active override repoint provider/target/fallback first.
   */
  resolve(model, fallbackFn = resolveConfiguredAlias) {
    if (!model) return model;
    const override = this._matchingOverride(model);
    if (!override) return fallbackFn(this.config, model, this.env);
    // Honour the override's provider choice. When an explicit provider is set
    // but currently disabled, fall back like the base resolver would.
    if (override.provider && override.provider !== "" && !this.enabledProvider(override.provider)) {
      return override.fallback || fallbackFn(this.config, model, this.env);
    }
    return override.target;
  }

  _matchingOverride(model) {
    const lower = String(model).toLowerCase();
    for (const alias of this.config.aliases) {
      const ov = this.overrides.get(alias.id);
      if (!ov) continue;
      if (alias.patterns.some((p) => wildcardRe(p).test(lower))) return ov;
    }
    return null;
  }
}

function wildcardRe(pattern) {
  return new RegExp(`^${String(pattern)
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`);
}

export function sanitizedPreferences(preferences) {
  return {
    version: 1,
    aliases: preferences.list(),
  };
}
