#!/usr/bin/env python3
"""Extend the prepared native profile source; never an installed runtime tree."""
import argparse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);a=p.parse_args()
def edit(name,old,new,count=1):
 path=a.source/name;s=path.read_text()
 if s.count(old)!=count:raise RuntimeError('billing anchor differs: '+name+' '+old[:70])
 path.write_text(s.replace(old,new))
# Replace only the planning function, retaining native attempt/stream machinery.
p=a.source/'sdk/api/handlers/canonical_policy.go';s=p.read_text();i=s.index('func (h *BaseAPIHandler) canonicalPlan(');j=s.index('func canonicalPair(',i);s=s[:i]+s[j:]
s=s.replace('Profile string','Profile string') # gofmt has not run yet
s=s.replace('Profile string','Profile string; Billing registry.BillingPolicy',1)
s=s.replace('Tier        int','Tier        int\n Billing registry.BillingPolicy',1)
s=s.replace('stage.Alternative && !canonicalCompatible(info, r)','stage.Alternative && !canonicalBillingCompatible(info, r)')
s=s.replace('headers.Set("X-Gateway-Cost-Policy", p.Policy)','headers.Set("X-Gateway-Cost-Policy", p.Policy);headers.Set("X-Gateway-Billing-Class",string(stage.Billing));headers.Set("X-Gateway-Billing-Policy",string(p.Billing))')
s=s.replace('ctx = context.WithValue(ctx, canonicalAttemptContextKey{}','ctx=registry.WithDispatchBilling(ctx,registry.RequestBillingPolicy(ctx,registry.ModelProfileFromContext(ctx),false).Policy)\n ctx = context.WithValue(ctx, canonicalAttemptContextKey{}',1)
# Freeze the effective plan permission, including :free and virtual profile aliases.
s=s.replace('canonicalAttemptContextFor(ctx, stage,','canonicalAttemptContextFor(registry.WithUncertainFeatureCost(registry.WithDispatchBilling(ctx,p.Billing),p.Requirements.UnverifiedCostFeatures), stage,')
s=s.replace('canonicalAttemptContextFor(attemptCtx, stage,','canonicalAttemptContextFor(registry.WithUncertainFeatureCost(registry.WithDispatchBilling(attemptCtx,p.Billing),p.Requirements.UnverifiedCostFeatures), stage,')
# Never replace an already-frozen permission inside the helper.
s=s.replace('ctx=registry.WithDispatchBilling(ctx,registry.RequestBillingPolicy(ctx,registry.ModelProfileFromContext(ctx),false).Policy)\n ','')
s=s.replace('if len(managers)>0&&managers[0]!=nil&&strings.HasSuffix(stage.Model,":free")&&!managers[0].CanonicalFallbackAvailable(id,stage.Model,time.Now()){blocked[id]=true;excluded=append(excluded,id)}','''if len(managers)>0&&managers[0]!=nil {
 m:=managers[0];a,ok:=m.GetByID(id);if !ok||m.CanonicalBillingClass(a,info,time.Now())!=stage.Billing||!m.CanonicalBillingAvailable(id,stage.Model,time.Now(),registry.DispatchBilling(ctx)){blocked[id]=true;excluded=append(excluded,id)}
 }''')

s=s.replace('bindings map[string]registry.CanonicalDispatchBinding) http.Header {','bindings map[string]registry.CanonicalDispatchBinding, ctx context.Context) http.Header {')
s=s.replace('canonicalHeaders(headers, p, stage, selected, count, bindings)','canonicalHeaders(headers, p, stage, selected, count, bindings,ctx)')
s=s.replace('return headers\n}', 'return billingResponseHeaders(headers,ctx,p)\n}',1)
s=s.replace('ctx = context.WithValue(ctx, canonicalAttemptContextKey{}', 'if len(bindings)>0{if trace:=registry.RoutingTraceFromContext(ctx);trace!=nil{trace.AwaitRoute()}}\n ctx = context.WithValue(ctx, canonicalAttemptContextKey{}',1)
p.write_text(s)
edit('sdk/api/handlers/canonical_policy.go','p, handled, invalid := h.canonicalPlan(ctx, model, raw, opts, !image && canonicalChatProtocol(entry))','if alt=="responses/compact"{ctx=registry.WithBoundModel(ctx)}\n p, handled, invalid := h.canonicalPlan(ctx, model, raw, opts, !image && canonicalChatProtocol(entry))',2)
# Include explicit overrides in the same bounded/fenced coordinator.
edit('internal/registry/canonical_registry.go','info != nil && canonicalRouteEntry(info) {\n\t\t\tout[client]', 'info != nil && info.CanonicalID!="" {\n\t\t\tout[client]')
edit('sdk/api/handlers/handlers.go','newCtx, cancel := context.WithCancel(parentCtx)','if requestCtx!=nil{parentCtx=registry.InheritBillingContext(parentCtx,requestCtx)}\n newCtx, cancel := context.WithCancel(parentCtx)')
# Admission happens after native authentication and before request dispatch.
p=a.source/'internal/api/server_middleware.go';s=p.read_text();i=s.index('func accessAuthMiddleware(');j=s.index('\nfunc realtimeAuthMiddleware(',i);part=s[i:j];anchor='\t\t\tc.Next()\n\t\t\treturn\n\t\t}\n\n\t\tcloseUnconsumedRequestOnAbort(c)';assert part.count(anchor)==1;part=part.replace(anchor,'\t\t\tif !routingAdmission(c){return}\n'+anchor);p.write_text(s[:i]+part+s[j:])
edit('internal/api/catalog_fallback_api_profiles.go','profile := s.engine.Group("/:profile/v1")','normal:=s.engine.Group("/v1");normal.Use(AuthMiddleware(s.accessManager));s.registerRoutingControlRoutes(normal)\n profile := s.engine.Group("/:profile/v1")')
edit('internal/api/catalog_fallback_api_profiles.go','profile.GET("/models",','s.registerRoutingControlRoutes(profile)\n profile.GET("/models",')
# Guard EVERY physical selected canonical/override attempt against frozen billing.
edit('sdk/cliproxy/auth/canonical_policy_execution.go','if strings.HasSuffix(route, ":free") && (!bound.Free||!m.CanonicalNoChargeAllowed(a,current,time.Now())) {','if err:=m.guardBillingDispatch(ctx,a,current,strings.TrimSuffix(strings.TrimSuffix(route,":free"),":paid"));err!=nil{return err}\n if strings.HasSuffix(route, ":free") && !bound.Free {')
# validateCanonicalDispatch previously lacked context; all guarded callers have it.
edit('sdk/cliproxy/auth/canonical_policy_execution.go','validateCanonicalDispatch(a *Auth,','validateCanonicalDispatch(ctx context.Context,a *Auth,')
edit('sdk/cliproxy/auth/canonical_policy_execution.go','m.validateCanonicalDispatch(a, req,','m.validateCanonicalDispatch(ctx,a, req,',3)
# Remove now-unused time import from generated predecessor.
edit('sdk/cliproxy/auth/canonical_policy_execution.go','"strings";"time"','"strings"')
# Final binding check/permit precede telemetry selection: rejected attempts are not serving routes.
p=a.source/'sdk/cliproxy/auth/canonical_policy_execution.go';s=p.read_text();line='if err:=m.guardBillingDispatch(ctx,a,current,strings.TrimSuffix(strings.TrimSuffix(route,":free"),":paid"));err!=nil{return err}\n '
s=s.replace(line,'');anchor='opts.Metadata["gateway.canonical_source_model"]';i=s.index(anchor);s=s[:i]+line+s[i:];p.write_text(s)

# Positive native free-price proof also belongs on provider-qualified overrides.
edit('sdk/cliproxy/canonical_registration.go','out[i].CanonicalFree = free','out[i].CanonicalFree = free;if compat!=nil&&free{out[i].CanonicalCostBasis="catalog-zero-price"}')
# Old unit calls are direct guard tests; use the conservative default context.
for test in (a.source/'sdk/cliproxy/auth').glob('*test.go'):
 text=test.read_text();text=text.replace('m.validateCanonicalDispatch(a,','m.validateCanonicalDispatch(context.Background(),a,');test.write_text(text)

edit('sdk/api/handlers/handlers_interceptors.go','if filtered,status:=h.filterProfileModelList(c,body);','body=h.appendProfileAliases(c,body)\n if filtered,status:=h.filterProfileModelList(c,body);')
edit('internal/registry/catalog_metadata.go','out["routing_policy"]="free-then-paid-same-model"','out["routing_policy"]="same-model-session-billing";out["default_billing_policy"]="SUB"')

# Capture late stream errors from native lifecycle, not HTTP200 alone.
edit('sdk/api/handlers/handlers_interceptors.go','t.once.Do(func() {','t.once.Do(func() {\n if outcome!=pluginapi.RequestCompletionSucceeded {if trace:=registry.RoutingTraceFromContext(t.ctx);trace!=nil{trace.AttemptFailed()}}')

edit('sdk/api/handlers/handlers_interceptors.go','"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"','"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces";"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"')

edit('sdk/cliproxy/canonical_registration.go','out[i].CanonicalFree = free;','out[i].CanonicalFree = free;if compat==nil{out[i].CanonicalCostBasis=canonicalAccountBillingBasis(cfg,a,source)};')
edit('sdk/cliproxy/canonical_registration.go','candidate.CanonicalFree = free;','candidate.CanonicalFree = free;if compat==nil{candidate.CanonicalCostBasis=canonicalAccountBillingBasis(cfg,a,source)};')
# Discovery distinguishes FREE from included subscription routes.
edit('internal/registry/catalog_metadata.go','len(GetGlobalRegistry().CanonicalRouteInfos(id+":free"))>0','canonicalHasFreeRoutes(id)')

edit('internal/api/catalog_fallback_api_profiles.go','profile.POST("/responses", r.Responses)','profile.POST("/responses", r.Responses)\n profile.POST("/responses/compact",r.Compact)')
edit('sdk/api/handlers/handlers_execution.go','func (h *BaseAPIHandler) executeCountWithAuthManager(', 'func (h *BaseAPIHandler) executeCanonicalCountAttempt(')
