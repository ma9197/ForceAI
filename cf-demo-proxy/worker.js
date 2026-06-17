// Serves the ForceAI demo (a separate Cloudflare Pages project) at mirsaidabbasov.com/forceai-demo,
// leaving the portfolio Pages project untouched on every other path. Same-path proxy: the demo is
// built with base "/forceai-demo/" and deployed under that folder on the Pages project, so paths line up.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // normalize the bare path to the folder so the SPA + relative assets resolve
    if (url.pathname === '/forceai-demo') {
      return Response.redirect(url.origin + '/forceai-demo/', 301);
    }
    const target = 'https://forceai-demo.pages.dev' + url.pathname + url.search;
    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });
    // rewrite any redirect that points back at the pages.dev origin to this host
    const loc = upstream.headers.get('location');
    if (loc && loc.includes('forceai-demo.pages.dev')) {
      const res = new Response(upstream.body, upstream);
      res.headers.set('location', loc.replace('https://forceai-demo.pages.dev', url.origin));
      return res;
    }
    return upstream;
  },
};
