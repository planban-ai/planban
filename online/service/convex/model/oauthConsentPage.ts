import { FAVICON_DATA_URI, WORDMARK_BLACK_DATA_URI } from "./brandAssets";
import { clerkScriptUrls } from "../../../../src/core/clerkPins";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const literal = (value: unknown) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export interface ConsentPage {
  nonce: string; frontend: string; key: string; returnTo: string; secret: string; csrf: string;
  clientName: string; clientId: string; permission: string; machine: boolean; offline: boolean; expiresAt?: number; serverNow?: number; ended?: boolean;
}

/** Branded presentation around the pinned Clerk components, never a custom identity flow. */
export function consentPage(page: ConsentPage): string {
  const { nonce, frontend, key, returnTo, secret, csrf } = page;
  const script = `(()=>{
    const signin=document.getElementById('signin'),allow=document.getElementById('allow'),deny=document.getElementById('deny');
    const status=document.getElementById('status'),identity=document.getElementById('identity'),email=document.getElementById('email');
    const auth=document.getElementById('auth'),review=document.getElementById('review'),ended=document.getElementById('ended');
    const cancelAuth=document.getElementById('cancel-auth');
    const account=document.getElementById('account-choice'),progress=document.getElementById('progress');
    let mounted=null,deciding=false,requestEnded=${literal(!!page.ended)},mode='signin',valid=false,validUntil=Infinity,generation=0,inflight=null,inflightGeneration=-1,offline=false;
    const OFFLINE='You\u2019re offline. Allow comes back when you reconnect.';
    const clock=()=>performance.now();
    const appearance={variables:{colorPrimary:'#0d0d0d',colorText:'#0d0d0d',colorTextSecondary:'#5d5d5d',colorBackground:'#fff',borderRadius:'6px',fontFamily:'-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif'},elements:{rootBox:{width:'100%'},cardBox:{width:'100%',boxShadow:'none',border:'1px solid #e9e9e9',borderRadius:'10px'},card:{padding:'28px'},headerTitle:{fontSize:'25px',letterSpacing:'-.7px'},formButtonPrimary:{boxShadow:'none'},footerActionLink:{color:'#0169cc'}}};
    function unmount(){if(mounted==='signin')Clerk.unmountSignIn(signin);if(mounted==='signup')Clerk.unmountSignUp(signin);mounted=null;}
    function render(){
      const active=Clerk.session&&Clerk.session.status==='active';
      identity.hidden=!active;
      if(active)email.textContent=Clerk.user?.primaryEmailAddress?.emailAddress||'Your account';
      auth.hidden=!!active||requestEnded;review.hidden=!active||requestEnded;ended.hidden=!requestEnded;
      allow.disabled=!active||deciding||requestEnded||!valid||offline;deny.disabled=deciding||requestEnded||!valid||offline;cancelAuth.disabled=deny.disabled;
      progress.textContent=requestEnded?'Connection request ended':active?'2 · Review access':'1 · Your account';
      if(requestEnded||active){unmount();return;}
      if(mounted!==mode){unmount();const props={routing:'hash',forceRedirectUrl:${literal(returnTo)},appearance};
        if(mode==='signup')Clerk.mountSignUp(signin,{...props,signInForceRedirectUrl:${literal(returnTo)}});
        else Clerk.mountSignIn(signin,{...props,signUpForceRedirectUrl:${literal(returnTo)}});
        mounted=mode;
      }
      account.textContent=mode==='signin'?'First time here? Create an account':'Already have an account? Sign in';
    }
    function endRequest(){generation++;valid=false;requestEnded=true;status.textContent='This request can no longer complete the connection. Return to your app to start a fresh request.';render();}
    async function refreshValidity(){
      if(requestEnded||document.hidden)return false;
      if(offline){valid=false;status.textContent=OFFLINE;render();return false;}
      valid=false;render();
      // A check started before the page was invalidated can't count: wait for it, then check again.
      if(inflight)return inflightGeneration===generation?inflight:inflight.then(()=>refreshValidity());
      const current=generation,started=clock();inflightGeneration=current;
      inflight=(async()=>{
        try{
          const response=await fetch('/oauth/validity',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request:${literal(secret)},csrf:${literal(csrf)}})});
          const result=await response.json();
          if(current!==generation||requestEnded||document.hidden)return false;
          if(!response.ok)throw Error();
          if(result.valid===false){endRequest();return false;}
          if(result.valid!==true||!Number.isFinite(result.serverNow)||!Number.isFinite(result.expiresAt)||result.expiresAt<=result.serverNow||result.expiresAt-result.serverNow>600000)throw Error();
          const remaining=result.expiresAt-result.serverNow-(clock()-started);
          validUntil=Math.min(validUntil,clock()+Math.max(0,remaining));
          if(clock()>=validUntil){endRequest();return false;}
          valid=true;status.textContent='';render();return true;
        }catch{if(current===generation&&!requestEnded){valid=false;status.textContent=offline?OFFLINE:'Could not verify this request. Access approval is unavailable until verification succeeds.';render();}return false;}
        finally{inflight=null;}
      })();return inflight;
    }
    function invalidate(){generation++;valid=false;render();}
    function restored(){invalidate();void refreshValidity();}
    // Going offline takes Allow away at once; reconnecting brings it back only after a fresh check.
    function wentOffline(){offline=true;invalidate();status.textContent=OFFLINE;render();}
    function cameOnline(){if(!offline)return;offline=false;status.textContent='';restored();}
    async function decide(decision){
      if(deciding||requestEnded)return;
      if(offline||!await refreshValidity()||deciding||requestEnded)return;
      deciding=true;const decisionGeneration=generation;render();
      try{
        const headers={'Content-Type':'application/x-www-form-urlencoded'};
        if(decision==='allow'){const token=await Clerk.session?.getToken();if(!token||requestEnded||!valid||decisionGeneration!==generation||clock()>=validUntil||document.hidden)throw Error();headers.Authorization='Bearer '+token;}
        if(requestEnded||!valid||decisionGeneration!==generation||clock()>=validUntil||document.hidden)throw Error();
        const response=await fetch('/oauth/approve',{method:'POST',redirect:'error',headers,body:new URLSearchParams({request:${literal(secret)},csrf:${literal(csrf)},decision})});
        const result=await response.json();if(!response.ok||!result.redirect)throw Error();window.location.assign(result.redirect);
      }catch{endRequest();}
    }
    allow.addEventListener('click',()=>decide('allow'));deny.addEventListener('click',()=>decide('deny'));cancelAuth.addEventListener('click',()=>decide('deny'));
    account.addEventListener('click',()=>{if(requestEnded||deciding)return;mode=mode==='signin'?'signup':'signin';render();});
    window.addEventListener('load',async()=>{
      try{await Clerk.load({nonce:${literal(nonce)},ui:{ClerkUI:window.__internal_ClerkUICtor}});Clerk.addListener(render);render();
        document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidate();else restored();});
        window.addEventListener('offline',wentOffline);window.addEventListener('online',cameOnline);
        if(typeof navigator!=='undefined'&&navigator.onLine===false)wentOffline();
        window.addEventListener('focus',restored);window.addEventListener('pageshow',restored);
        const tick=()=>{if(!requestEnded){if(clock()>=validUntil)endRequest();else if(!document.hidden&&!inflight&&!deciding)void refreshValidity();setTimeout(tick,15000);}};
        setInterval(()=>{if(!requestEnded&&clock()>=validUntil)endRequest();},1000);
        if(!requestEnded){await refreshValidity();setTimeout(tick,15000);}}
      catch{allow.disabled=true;status.textContent='Sign-in could not load. Return to your app to start again.';}
    });
  })();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="icon" href="${FAVICON_DATA_URI}"><title>Connect to Planban</title><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;background:#f9f9f9;color:#0d0d0d;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif}header{padding:22px 28px;border-bottom:1px solid #e9e9e9;background:#fff;display:flex;align-items:center;gap:9px;font-size:17px;font-weight:650;letter-spacing:-.4px}header img{height:24px;width:auto;display:block}header span{margin-left:auto;font-size:11px;font-weight:450;letter-spacing:0;color:#5d5d5d}main{width:100%;max-width:458px;margin:42px auto;padding:0 20px}#progress{font-size:12px;color:#5d5d5d;margin-bottom:20px}.intro{color:#5d5d5d;margin:0 0 18px}.card{padding:28px;background:#fff;border:1px solid #e9e9e9;border-radius:10px;box-shadow:0 1px 2px #00000006}h1{font-size:25px;line-height:1.2;letter-spacing:-.7px;margin:0 0 10px;font-weight:650}p{margin:0 0 16px}.sub{color:#5d5d5d;font-size:13px}#identity{border-bottom:1px solid #e9e9e9;padding:0 0 18px;margin:0 0 18px}#email{display:block;font-weight:600;font-size:13px;overflow-wrap:anywhere}.permissions{list-style:none;margin:0 0 18px;padding:0}.permissions li{border-bottom:1px solid #e9e9e9;padding:10px 0}.permissions strong{display:block;font-size:13px;font-weight:550}.permissions span{display:block;font-size:12px;color:#5d5d5d;margin-top:3px}.details{background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px;color:#5d5d5d;margin-bottom:18px}.actions{display:flex;gap:9px}button{font:inherit;cursor:pointer;border:1px solid #ddd;background:#fff;color:#333;padding:11px 16px;border-radius:6px;font-weight:550}.actions button{flex:1}.primary{background:#0d0d0d;color:#fff;border-color:#0d0d0d}button:disabled{background:#eee;color:#777;border-color:#ddd;cursor:default}button:focus-visible{outline:2px solid #0169cc;outline-offset:3px}#account-choice{margin-top:16px;width:100%;color:#0169cc;font-size:13px}#status{color:#5d5d5d;font-size:13px;margin-top:16px}.foot{color:#5d5d5d;font-size:12px;text-align:center;margin:18px 0}footer{color:#777;font-size:11px;text-align:center;margin:28px 0;padding:0 20px}code{font:11px ui-monospace,monospace;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:430px){header{padding:18px 20px}main{margin-top:26px}.card{padding:22px}.actions{flex-direction:column}}
  </style></head><body><header><img src="${WORDMARK_BLACK_DATA_URI}" alt="Planban"><span>${key.startsWith("pk_test_") ? "Development app" : "Account and connections"}</span></header><main><div id="progress">1 · Your account</div>
  <div id="auth"${page.ended ? " hidden" : ""}><p class="intro">Sign in first. Then review whether to connect ${page.machine ? "this computer" : escape(page.clientName)}.</p><div id="signin"></div><button id="account-choice" type="button">First time here? Create an account</button><p class="foot">Creating or signing in to an account does not approve access.<br>Your local boards stay on your device.</p><button id="cancel-auth" type="button" style="width:100%" disabled>Cancel request</button></div>
  <div id="identity" hidden><strong id="email"></strong><span class="sub">Your account is signed in</span></div>
  <div id="review" class="card" hidden><h1>${page.machine ? "Connect this computer?" : `Connect ${escape(page.clientName)}?`}</h1><p class="sub">${page.machine ? "The Planban command line" : escape(page.clientName)} is asking to use your account.</p><ul class="permissions"><li><strong>${escape(page.permission)}</strong><span>This applies to boards your account can access.</span></li><li><strong>Your permissions still apply</strong><span>Board permissions and agent limits are enforced.</span></li></ul>${page.machine || page.offline ? `<div class="details">${page.machine ? "This computer" : "This app"} can stay connected until you revoke it, or it is unused for 90 days.${page.offline ? " Authorization ends after one year." : ""}</div>` : ""}<p class="sub">App: <code>${escape(page.clientId)}</code></p><div class="actions"><button id="deny" type="button">Cancel</button><button id="allow" class="primary" type="button" disabled>Allow connection</button></div><p class="foot">Only choose Allow if you started this request.<br>Connecting does not take any local board online.</p></div>
  <div id="ended" class="card"${page.ended ? "" : " hidden"}><h1>Start a new sign-in</h1><p class="sub">This request can no longer complete the connection.</p><div class="details">Return to the app that opened this page to start a fresh request. Review and approve that new request when you are ready.</div><button class="primary" type="button" disabled style="width:100%">Allow unavailable</button><p class="foot">This page will not start another request or sign you out.</p></div><p id="status" role="status" aria-live="polite">Loading sign-in…</p></main><footer>Planban · Account and connections</footer>
  <script nonce="${nonce}" defer crossorigin="anonymous" src="${escape(clerkScriptUrls(frontend).ui)}"></script><script nonce="${nonce}" defer crossorigin="anonymous" data-clerk-publishable-key="${escape(key)}" src="${escape(clerkScriptUrls(frontend).js)}"></script><script nonce="${nonce}">${script}</script></body></html>`;
}
