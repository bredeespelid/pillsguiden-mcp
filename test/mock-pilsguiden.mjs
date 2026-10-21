import http from "node:http";
import { stringify } from "devalue";
const bar=(id,name,address,brewery,size,price,pint,checked,valid_to,def)=>({id,name,address,slug:name.toLowerCase().replace(/\W+/g,"-"),location:25,brewery,size,price,pint,price_checked:checked,valid_to,default_price:def,NextLoc:{id:0,name:"",slug:""}});
const list={location_id:1,stats:{location_name:"Oslo",mean:119,median:120,count:589,parent_id:1954,parent_name:"Norge",parent_count:1622,parent_mean:123,parent_median:124},
bars:[bar(1689,"Doug's Hamburgers Aker Brygge","Fjordalléen 4, 0250 Oslo","Budweiser",0.5,55,55,"2026-10-16T17:16:19+02:00","Prisen er alltid gyldig",true),
bar(1705,"Phuket Restaurant Oslo","Herslebs gate 4a, 0561 Oslo","Ringnes",0.5,56,56,"2026-10-19T20:56:34+02:00","Prisen er alltid gyldig",true),
bar(1537,"Destiny Pub Oslo","Bernt Ankers gate 37, 0179 Oslo","1489",0.5,59,59,"2026-10-09T12:45:54+02:00","Gyldig frem til kl 21",false),
bar(1792,"SIP Oslo","Storgata 13, 0155 Oslo","Hansa",0.4,49,61,"2026-10-17T23:50:23+02:00","Gyldig frem til kl 21",false),
bar(1082,"Bar Royal","Hausmanns gate 8B, 0182 Oslo","Ringnes",0.5,69,69,"2026-09-11T18:34:46+02:00","Prisen gjelder utenom happy hour",true),
bar(1469,"Anam Cara Bar Oslo","Rostockgata 42, 0194 Oslo","Frydenlund",0.4,66,82,"2025-09-06T13:26:47+02:00","Gyldig frem til kl 19",false),
bar(656,"Cafe Stolen","Helgesens gate 32, 0553 Oslo","Hansa",0.5,75,75,"2026-09-16T17:57:23+02:00","Prisen gjelder til stengetid",false)],
links:[{id:2,name:"Grünerløkka",slug:"grunerlokka"},{id:3,name:"Sentrum",slug:"sentrum"}],breadcrumb:[{name:"Oslo",slug:"oslo"}]};
const body=JSON.stringify({type:"data",nodes:[{type:"data",data:JSON.parse(stringify({admin:false,consent:false})),uses:{}},{type:"data",data:JSON.parse(stringify({list})),uses:{}}]});
http.createServer((q,r)=>{ if(q.url.startsWith("/liste/oslo")){r.setHeader("content-type","application/json");r.end(body)} else {r.statusCode=404;r.end("{}")}}).listen(4010);
