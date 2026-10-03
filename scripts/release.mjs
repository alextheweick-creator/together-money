
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync('desktop/service.json','utf8').replace(/^\uFEFF/,''));
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.updateRepository||''))throw new Error('Configure updateRepository in desktop/service.json.');
if(process.platform==='darwin'&&!process.env.CSC_LINK)throw new Error('Mac releases require an Apple Developer signing certificate (CSC_LINK).');
if(process.platform==='darwin'&&!(process.env.APPLE_ID&&process.env.APPLE_APP_SPECIFIC_PASSWORD&&process.env.APPLE_TEAM_ID))throw new Error('Configure Apple notarization credentials before publishing a Mac release.');
if(!process.env.GH_TOKEN)throw new Error('GH_TOKEN is required in the release environment, never in the desktop app.');
const [owner,repo]=config.updateRepository.split('/');
const args=['node_modules/electron-builder/out/cli/cli.js',...(process.platform==='win32'?['--win','nsis','--x64']:['--mac','dmg','zip','--arm64','--x64']),'--publish','always','--config.publish.provider=github','--config.publish.owner='+owner,'--config.publish.repo='+repo,'--config.publish.releaseType=draft'];
const result=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});process.exit(result.status||0);

