'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const template=fs.readFileSync(path.join(__dirname,'v1-ui.template.html'),'utf8');
const core=fs.readFileSync(path.join(root,'v1-core.js'),'utf8').replace(/<\/script/gi,'<\\/script');
fs.writeFileSync(path.join(root,'eth-dynamic-trading-dashboard.html'),template.replace('/*__CORE__*/',core));
console.log('built eth-dynamic-trading-dashboard.html');
