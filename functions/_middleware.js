export async function onRequest(context) {
  const url = new URL(context.request.url);
  
  if (url.pathname.startsWith('/api/')) {
    const workerUrl = new URL(url.pathname + url.search, 'https://cryptomind-pro-backend.azaanbk30.workers.dev');
    return fetch(new Request(workerUrl, context.request));
  }
  
  return context.next();
}
