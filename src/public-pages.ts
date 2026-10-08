import express from 'express';
import {fileURLToPath} from 'node:url';

export function publicPages(){
  const router=express.Router({caseSensitive:true,strict:true});
  for(const [route,file] of [['/','index.html'],['/privacy','privacy.html'],['/terms','terms.html']]){
    router.get(route!,(_req,res)=>res.sendFile(fileURLToPath(new URL('../public/'+file,import.meta.url))));
  }
  return router;
}

// Bootstrap serves information only while Google credentials are being configured.
export function createPublicApp(origin:string){
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});
    if(req.headers.host!==new URL(origin).host)return void res.status(400).send('Invalid host');
    next();
  });
  app.use(publicPages());
  app.all('/mcp',(_req,res)=>res.status(503).send('Connector setup is not complete.'));
  app.use((_req,res)=>res.status(404).send('Not found'));
  app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(!res.headersSent)res.status(500).send('Request failed');
  });
  return app;
}
