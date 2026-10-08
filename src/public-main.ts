import {loadConfig} from './config.js';
import {paths} from './paths.js';
import {createPublicApp} from './public-pages.js';

try{
  const config=loadConfig(paths().config);
  const server=createPublicApp(config.origin).listen(config.port,'127.0.0.1',()=>console.log('event=public_pages_started'));
  server.on('error',()=>{console.error('event=listen_failed');process.exitCode=1;});
  const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{console.error('event=startup_failed');process.exitCode=1;}
