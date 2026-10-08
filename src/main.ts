import {loadConfig} from './config.js';
import {Store,readPrivateFile} from './store.js';
import {createApp} from './app.js';
import {Gmail} from './gmail.js';
import {paths} from './paths.js';

function main(){
  const p=paths();const config=loadConfig(p.config);const store=new Store(p.state,readPrivateFile(p.key));
  const {app}=createApp(config,store,new Gmail(config,store));
  const server=app.listen(config.port,'127.0.0.1',()=>console.log('event=server_started'));
  const prune=setInterval(()=>{try{store.prune();}catch{console.error('event=state_cleanup_failed');}},60000);prune.unref();
  server.on('error',()=>{console.error('event=listen_failed');process.exitCode=1;clearInterval(prune);store.close();});
  const stop=()=>{clearInterval(prune);server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
try{main();}catch{console.error('event=startup_failed');process.exitCode=1;}
