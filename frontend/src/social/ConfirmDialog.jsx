import { useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { C, FONT, BTN } from './constants.js';

export function useConfirm() {
  const [opts, setOpts] = useState(null);
  const [resolver, setResolver] = useState(null);

  const confirm = useCallback((o={}) => new Promise(resolve => {
    setOpts({title:'Are you sure?',body:'This action cannot be undone.',confirmLabel:'Confirm',cancelLabel:'Cancel',danger:false,...o});
    setResolver(()=>resolve);
  }), []);

  function close(result) {
    setOpts(null);
    if (resolver) { resolver(result); setResolver(null); }
  }

  const dialog = opts ? (
    <div onClick={()=>close(false)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.42)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1500,backdropFilter:'blur(4px)',animation:'fade-in .18s ease-out both'}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:24,padding:24,maxWidth:440,width:'92%',boxShadow:C.shadowLg,fontFamily:FONT,animation:'fc-pop-in .2s ease-out both'}}>
        <div style={{display:'flex',alignItems:'flex-start',gap:14,marginBottom:14}}>
          <div style={{width:40,height:40,borderRadius:12,background:opts.danger?C.errBg:C.amberSoft,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <AlertTriangle size={19} color={opts.danger?C.errText:C.amber}/>
          </div>
          <div style={{minWidth:0}}>
            <div style={{fontSize:16,fontWeight:650,letterSpacing:'-0.02em',color:C.text,marginBottom:6}}>{opts.title}</div>
            <div style={{fontSize:14,color:C.textSecondary,lineHeight:1.5,whiteSpace:'pre-line'}}>{opts.body}</div>
          </div>
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18}}>
          <button onClick={()=>close(false)} style={BTN.secondary}>{opts.cancelLabel}</button>
          <button onClick={()=>close(true)} autoFocus style={{...BTN.primary, background: opts.danger ? C.primaryHover : C.primary}}>{opts.confirmLabel}</button>
        </div>
      </div>
    </div>
  ) : null;

  return [dialog, confirm];
}
