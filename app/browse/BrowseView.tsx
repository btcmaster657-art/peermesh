'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PeerRequester } from '@/lib/peer-requester'
import { getFlagForCountry } from '@/lib/utils'

let requester: PeerRequester | null = null

function proxyAsset(url: string): string {
  if (!url) return ''
  if (url.includes('proxy-asset') || url.includes('localhost')) return url
  // Only proxy absolute URLs — relative URLs should have been resolved before calling this
  if (!url.startsWith('http')) return url
  return `/api/proxy-asset?url=${encodeURIComponent(url)}`
}

function rewriteLinks(html: string, baseUrl: string, accessToken: string): string {
  try {
    const base = new URL(baseUrl)
    const origin = base.origin

    // Intercept script — must use native fetch to avoid recursion
    const interceptScript = `<script>
(function(){
  var ORIGIN='${origin}';
  var PROXY='/api/proxy-fetch';
  var TOKEN='${accessToken}';
  var _fetch=window.fetch.bind(window);
  function proxyFetch(url,method,headers,body){
    // Use native fetch directly to avoid recursion
    return _fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({url:url,method:method||'GET',headers:headers||{},body:body||null})})
      .then(function(r){return r.json();})
      .then(function(d){return new Response(d.body||'',{status:d.status||200,headers:d.headers||{}});});
  }
  function shouldProxy(url){
    return url&&url.startsWith('http')&&!url.includes('localhost')&&!url.includes('127.0.0.1');
  }
  function resolveUrl(url){
    if(!url||typeof url!=='string') return url;
    if(url.startsWith('http')||url.startsWith('//')||url.startsWith('data:')||url.startsWith('blob:')||url.startsWith('javascript:')) return url;
    try{ return ORIGIN+(url.startsWith('/')?url:'/'+url); }catch(e){ return url; }
  }
  window.fetch=function(input,init){
    var url=typeof input==='string'?input:(input&&input.url?input.url:String(input));
    url=resolveUrl(url);
    if(shouldProxy(url)){
      return proxyFetch(url,(init&&init.method)||'GET',(init&&init.headers)||{},(init&&init.body)||null);
    }
    return _fetch(input,init);
  };
  var _XHR=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){
    var xhr=new _XHR(),_m='GET',_u,_isProxy=false;
    xhr.open=function(m,u){
      _m=m; _u=resolveUrl(u);
      _isProxy=shouldProxy(_u);
      if(_isProxy){ _XHR.prototype.open.call(xhr,'POST',PROXY); }
      else { _XHR.prototype.open.call(xhr,m,u); }
    };
    xhr.send=function(body){
      if(_isProxy){
        _XHR.prototype.setRequestHeader.call(xhr,'Content-Type','application/json');
        if(TOKEN) _XHR.prototype.setRequestHeader.call(xhr,'Authorization','Bearer '+TOKEN);
        _XHR.prototype.send.call(xhr,JSON.stringify({url:_u,method:_m,headers:{},body:body||null}));
      } else { _XHR.prototype.send.call(xhr,body); }
    };
    return xhr;
  };
  try{history.pushState=history.replaceState=function(){};}catch(e){}
  document.addEventListener('click',function(e){
    var el=e.target.closest('[data-proxy]');
    if(el){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:'proxy-navigate',url:el.dataset.proxy},'*');}
  },true);
})();
</script>`

    const withIntercept = html.includes('<head')
      ? html.replace(/(<head[^>]*>)/i, `$1${interceptScript}`)
      : html.includes('<html')
        ? html.replace(/(<html[^>]*>)/i, `$1${interceptScript}`)
        : interceptScript + html

    return withIntercept
      // Remove preload/prefetch
      .replace(/<link[^>]+rel=["'](preload|prefetch|preconnect|dns-prefetch)["'][^>]*>/gi, '')
      // Rewrite all link href (stylesheets, etc) — relative and absolute
      .replace(/(<link[^>]+href=")(https?:\/\/[^"]+)(")/gi, (_, pre, url, post) =>
        `${pre}${proxyAsset(url)}${post}`
      )
      .replace(/(<link[^>]+href=")(\/(?!api\/)[^"]+)(")/gi, (_, pre, path, post) => {
        try { return `${pre}${proxyAsset(new URL(path, base).href)}${post}` }
        catch { return `${pre}${path}${post}` }
      })
      // Rewrite anchor href — absolute
      .replace(/(<a[^>]+)href="(https?:\/\/[^"]+)"/gi, (_, pre, url) =>
        `${pre}href="#" data-proxy="${url}"`
      )
      // Rewrite anchor href — relative
      .replace(/(<a[^>]+)href="(\/(?!api\/)[^"]+)"/gi, (_, pre, path) => {
        try { return `${pre}href="#" data-proxy="${new URL(path, base).href}"` }
        catch { return `${pre}href="#"` }
      })
      // Rewrite absolute src — also decode &amp; in URLs
      .replace(/src="(https?:\/\/[^"]+)"/g, (_, url) => `src="${proxyAsset(url.replace(/&amp;/g, '&'))}"`)
      // Rewrite relative src with leading slash
      .replace(/src="(\/(?!api\/)[^"]+)"/g, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` }
        catch { return `src=""` }
      })
      // Rewrite relative src without leading slash
      .replace(/src="((?!https?:|data:|blob:|\/)([^"]+))"/g, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` }
        catch { return `src=""` }
      })
      // Rewrite relative img src without leading slash
      .replace(/src="((?!https?:|data:|blob:|\/)([^"]+\.(png|jpg|jpeg|gif|webp|svg|ico)))"/gi, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` }
        catch { return `src=""` }
      })
      // Remove ES module scripts that load from /api/ paths (Framer/Vite artifacts)
      .replace(/<script[^>]+type=["']module["'][^>]*src=["'][^"']*\/api\/[^"']*["'][^>]*><\/script>/gi, '')
  } catch {
    return html
  }
}

export default function BrowseView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // dbSessionId = the session row we created in Supabase (for end-session API)
  // relay assigns its own live session ID during WebRTC handshake
  const relayEndpoint = searchParams.get('relay') ?? ''
  const country = searchParams.get('country') ?? ''
  const userId = searchParams.get('userId') ?? ''
  const dbSessionId = searchParams.get('dbSessionId') ?? ''
  const preferredProviderUserId = searchParams.get('preferredProviderUserId') ?? null
  const privateProviderUserId = searchParams.get('privateProviderUserId') ?? null
  const privateBaseDeviceId = searchParams.get('privateBaseDeviceId') ?? null

  const [inputUrl, setInputUrl] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<'connecting' | 'ready' | 'loading' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const bytesUsedRef = useRef(0)
  const [bytesUsed, setBytesUsed] = useState(0)

  useEffect(() => {
    if (!relayEndpoint) { router.push('/dashboard'); return }

    requester = new PeerRequester()
    requester
      .connect(relayEndpoint, dbSessionId, country, userId, () => {
        setStatus('error')
        setErrorMsg('Peer disconnected unexpectedly')
      }, preferredProviderUserId, privateProviderUserId, privateBaseDeviceId)
      .then(() => setStatus('ready'))
      .catch(err => { setStatus('error'); setErrorMsg(err.message) })

    // Get access token for proxy-fetch auth inside iframe
    fetch('/api/agent-token').then(r => r.json()).then(d => setAccessToken(d.token ?? '')).catch(() => {})

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'proxy-navigate') navigate(e.data.url)
    }
    window.addEventListener('message', onMessage)

    return () => {
      window.removeEventListener('message', onMessage)
      // Only clean up if we actually connected — avoids strict mode double-mount issue
      if (requester) doEndSession()
    }
  }, [])

  async function doEndSession() {
    if (!requester) return
    const r = requester
    requester = null  // set null first to prevent double-call
    const bytes = bytesUsedRef.current
    r.disconnect()
    if (dbSessionId) {
      await fetch('/api/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: dbSessionId, bytesUsed: bytes }),
      }).catch(() => {})
    }
  }

  const navigate = useCallback(async (target: string) => {
    if (!requester?.isConnected) return
    let finalUrl = target.trim()
    if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl

    // Sites that require full browser context — can't work in iframe
    const IFRAME_INCOMPATIBLE = [
      'youtube.com', 'google.com', 'gmail.com', 'facebook.com',
      'instagram.com', 'twitter.com', 'x.com', 'netflix.com',
      'accounts.google.com',
    ]
    try {
      const hostname = new URL(finalUrl).hostname.replace('www.', '')
      if (IFRAME_INCOMPATIBLE.some(d => hostname.endsWith(d))) {
        setStatus('ready')
        setContent(`<html><body style="font-family:monospace;padding:40px;background:#0a0a0f;color:#e8e8f0;line-height:1.8">
          <h2 style="color:#00ff88;margin-bottom:16px">${hostname}</h2>
          <p style="color:#666680;margin-bottom:24px">This site uses advanced browser APIs that can't run inside a proxied iframe.</p>
          <p style="color:#e8e8f0;margin-bottom:8px">To browse ${hostname} through the RW peer:</p>
          <ol style="color:#666680;padding-left:20px">
            <li style="margin-bottom:8px">The agent is running and routing is active</li>
            <li style="margin-bottom:8px">Open a <strong style="color:#e8e8f0">new browser tab</strong> and visit the site directly</li>
            <li style="margin-bottom:8px">Your traffic will appear to come from Rwanda</li>
          </ol>
          <p style="color:#666680;font-size:12px;margin-top:24px">Sites that work well in the proxy browser: wikipedia.org, bbc.com, reuters.com, news sites, blogs, e-commerce.</p>
        </body></html>`)
        return
      }
    } catch {}

    setCurrentUrl(finalUrl)
    setInputUrl(finalUrl)
    setStatus('loading')
    setContent('')

    try {
      const res = await requester.fetch(finalUrl)
      if (res.error && !res.body) throw new Error(res.error)
      const actualUrl = (res as any).finalUrl || finalUrl
      setBytesUsed(b => b + res.body.length)
      bytesUsedRef.current += res.body.length
      setContent(rewriteLinks(res.body, actualUrl, accessToken))
      setStatus('ready')
    } catch (err: unknown) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load page')
    }
  }, [])

  async function handleDisconnect() {
    await doEndSession()
    router.push('/dashboard')
  }

  const flag = getFlagForCountry(country)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>

      {/* Browser chrome */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        <button
          onClick={handleDisconnect}
          style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', whiteSpace: 'nowrap' }}
        >
          ← EXIT
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', background: 'var(--accent-dim)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '6px', whiteSpace: 'nowrap' }}>
          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: status === 'ready' || status === 'loading' ? 'var(--accent)' : 'var(--muted)', boxShadow: status === 'ready' ? '0 0 6px var(--accent)' : 'none' }} />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px' }}>
            {flag} {country}
          </span>
        </div>

        <form onSubmit={e => { e.preventDefault(); navigate(inputUrl) }} style={{ flex: 1, display: 'flex', gap: '8px' }}>
          <input
            value={inputUrl}
            onChange={e => setInputUrl(e.target.value)}
            placeholder="Enter URL..."
            disabled={status === 'connecting'}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', color: 'var(--text)', fontSize: '13px', outline: 'none', fontFamily: 'var(--font-geist-mono)' }}
          />
          <button
            type="submit"
            disabled={status === 'connecting' || !inputUrl}
            style={{ padding: '8px 16px', background: status === 'connecting' || !inputUrl ? 'var(--border)' : 'var(--accent)', color: status === 'connecting' || !inputUrl ? 'var(--muted)' : '#000', border: 'none', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: status === 'connecting' || !inputUrl ? 'not-allowed' : 'pointer', letterSpacing: '0.5px' }}
          >
            GO
          </button>
        </form>

        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          {(bytesUsed / 1024).toFixed(1)}KB
        </span>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {status === 'connecting' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
            <div style={{ width: '32px', height: '32px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)', letterSpacing: '1px' }}>CONNECTING TO {flag} {country} PEER...</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

      {/* Active session info */}
      {status === 'ready' && !content && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '40px' }}>
          <div style={{ fontSize: '48px' }}>{flag}</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--accent)', letterSpacing: '1px' }}>CONNECTED · {country} PEER</div>
          <div style={{ fontSize: '13px', color: 'var(--muted)', textAlign: 'center', maxWidth: '400px', lineHeight: 1.7 }}>
            Enter a URL above to browse through this peer.
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px 20px', maxWidth: '400px', width: '100%' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '10px' }}>WORKS WELL</div>
            {['wikipedia.org', 'bbc.com', 'reuters.com', 'cnn.com', 'amazon.com'].map(site => (
              <button
                key={site}
                onClick={() => navigate(site)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 0', background: 'none', border: 'none', color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
              >
                → {site}
              </button>
            ))}
          </div>
        </div>
      )}

        {status === 'loading' && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'var(--accent)', animation: 'progress 1.5s ease-in-out infinite' }}>
            <style>{`@keyframes progress{0%{width:0%}50%{width:70%}100%{width:100%}}`}</style>
          </div>
        )}

        {status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--danger)', letterSpacing: '1px' }}>CONNECTION ERROR</div>
            <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{errorMsg}</div>
            <button onClick={handleDisconnect} style={{ padding: '10px 20px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', cursor: 'pointer' }}>
              BACK TO DASHBOARD
            </button>
          </div>
        )}

        {content && (
          <iframe
            ref={iframeRef}
            srcDoc={content}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            title={`Browsing via ${country} peer`}
          />
        )}
      </div>

      {/* Footer */}
      <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '6px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>
          {currentUrl ? (() => { try { return new URL(currentUrl).hostname } catch { return currentUrl } })() : 'No page loaded'}
        </span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>
          {dbSessionId ? dbSessionId.slice(0, 8) + '...' : 'connecting...'}
        </span>
      </div>
    </div>
  )
}
