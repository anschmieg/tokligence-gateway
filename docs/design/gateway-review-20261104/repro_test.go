package handlers
import (
 "testing"
 "time"
 "github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
 "github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
 "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)
func TestReviewFreeOnlyProfileAdmitsSubscription(t *testing.T) {
 h,e:=profileFixture(t,map[string]int{"cf-kilo":503})
 models:=registry.GetGlobalRegistry().GetModelsForClient("cf-other")
 for _,m:=range models {m.PluginCostTier="included"}
 registry.GetGlobalRegistry().RegisterClient("cf-other",e.Identifier(),models)
 p:=h.AuthManager.CanonicalRoutingPolicy()
 p.Profiles=map[string]registry.ModelProfile{"coding":{Task:catalogfallback.Coding,MaxModels:12,PreferredModel:"glm-5.3-flash",CostPolicy:"free-only"}}
 p.NoChargeAllowances=[]registry.NoChargeAllowance{{Provider:e.Identifier(),AuthID:"cf-other",SourceModels:[]string{"upstream-glm-5.3-flash"},Basis:"fake included allowance",VerifiedUntil:time.Now().Add(time.Hour).UTC().Format(time.RFC3339),NoPaidOverage:true}}
 h.AuthManager.SetConfig(&config.Config{Models:registry.CatalogSources{CanonicalOnly:true,CanonicalRouting:p}})
 _,headers,err:=h.ExecuteWithAuthManager(billingContext(t,registry.BillingSub,"coding"),"openai","glm-5.3-flash",[]byte(billingRaw),"")
 if err!=nil || headers.Get("X-Gateway-Billing-Class")!="SUB" {t.Fatalf("counterexample not reproduced: %v %v %v",err,headers,e.calls)}
 t.Logf("free-only profile served subscription: %v",e.calls)
}
func TestReviewPaidProfileRejectsExplicitlyAuthorizedFeatures(t *testing.T) {
 h,e:=profileFixture(t,nil)
 _,_,err:=h.ExecuteWithAuthManager(billingContext(t,registry.BillingPaid,"coding"),"openai","glm-5.3-flash",[]byte(`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search"}]}`),"")
 if err==nil || err.StatusCode!=409 || len(e.calls)!=0 {t.Fatalf("counterexample not reproduced: %v %v",err,e.calls)}
 t.Logf("PAID profile rejected before any dispatch: %v",err)
}
