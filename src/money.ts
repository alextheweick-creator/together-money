export const categories=['Groceries','Dining out','Home','Utilities','Transport','Shopping','Health','Entertainment','Travel','Other'];
export type Transaction={id:string;date:string;merchant:string;amount:number;payer:'you'|'partner';kind:'expense'|'refund'|'income'|'transfer'|'settlement';category:string;share:number;note:string;reviewed:number;pending:number;removed?:number;source:string;account:string;updated?:string};
export type Settings={you:string;partner:string;defaultShare:number;budgets:Record<string,number>};
export const defaults:Settings={you:'You',partner:'Partner',defaultShare:50,budgets:{Groceries:60000,'Dining out':25000,Home:180000,Utilities:25000,Transport:20000}};
export const dollars=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
export function shares(t:Transaction){const yours=Math.round(t.amount*t.share/100);return {you:yours,partner:t.amount-yours};}
export function summarize(ts:Transaction[],month?:string){
 const approved=ts.filter(t=>t.reviewed&&!t.pending&&!t.removed);
 const spending=approved.filter(t=>t.kind==='expense'||t.kind==='refund');
 const range=spending.filter(t=>!month||t.date.startsWith(month));
 const totals={spending:0,you:0,partner:0,youPaid:0,partnerPaid:0,income:0,balance:0,categories:{} as Record<string,number>,daily:{} as Record<string,number>};
 for(const t of range){const split=shares(t);totals.spending+=t.amount;totals.you+=split.you;totals.partner+=split.partner;totals[t.payer==='you'?'youPaid':'partnerPaid']+=t.amount;totals.categories[t.category]=(totals.categories[t.category]||0)+t.amount;totals.daily[t.date]=(totals.daily[t.date]||0)+t.amount;}
 for(const t of approved){if(t.kind==='income'&&(!month||t.date.startsWith(month)))totals.income-=t.amount;if(t.kind==='expense'||t.kind==='refund')totals.balance+=(t.payer==='you'?t.amount:0)-shares(t).you;if(t.kind==='settlement')totals.balance+=t.payer==='you'?t.amount:-t.amount;}
 return totals;
}
export function localDay(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
export function samples():Transaction[]{const day=(ago:number)=>{const d=new Date();d.setDate(d.getDate()-ago);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};return [
{id:'demo-1',date:day(3),merchant:'Neighborhood Market',amount:12000,payer:'you',kind:'expense',category:'Groceries',share:50,reviewed:0},
{id:'demo-2',date:day(2),merchant:'Corner Table',amount:8000,payer:'partner',kind:'expense',category:'Dining out',share:50,reviewed:0},
{id:'demo-3',date:day(1),merchant:'Monthly paycheck',amount:-285000,payer:'you',kind:'income',category:'Other',share:100,reviewed:0},
{id:'demo-4',date:day(0),merchant:'Electric company',amount:9600,payer:'partner',kind:'expense',category:'Utilities',share:50,reviewed:0},
{id:'demo-5',date:day(4),merchant:'October rent',amount:180000,payer:'you',kind:'expense',category:'Home',share:50,reviewed:1},
{id:'demo-6',date:day(4),merchant:'Partner repayment',amount:-90000,payer:'you',kind:'settlement',category:'Other',share:50,reviewed:1}
].map(t=>({...t,note:'',pending:0,source:'demo',account:'Sample account'})) as Transaction[];}

