(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.VerificationCustomers=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Customer spelling and order supplied by the user. Match complete names,
  // never infer a customer from a product number or a partial name.
  const names=Object.freeze([
    'AZAD','Brybelly +Entertoymen','CareFocus','Cepia','Character Torld','Fat brain',
    'JAZWARES','John Adams','Just Play','Lifelines','Masterkidz','Melissa & Doug（印尼）',
    'Moose','North Star','PWP（多美）','Sky Castle','SpinMaster-毛绒（印尼）','TOMY',
    'Tigerhead','Tikino','Tokidos','ToyMonster','ZURU','Zanzoon(嘉苏)','智海鑫','永恒'
  ]);
  const key=value=>String(value??'').trim().replace(/\s+/g,'').replace(/（/g,'(').replace(/）/g,')').toUpperCase();
  const canonical=new Map(names.map(name=>[key(name),name]));
  // These are the existing Zanzoon import labels, not separate customers.
  for(const alias of ['ZANZOON','嘉苏A'])canonical.set(key(alias),'Zanzoon(嘉苏)');
  function display(value){return canonical.get(key(value))||String(value??'').trim();}
  function options(existing=[]){return [...names,...new Set(existing.map(display).filter(name=>name&&!names.includes(name)))];}
  return {names,display,options};
});
