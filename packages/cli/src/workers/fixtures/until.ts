import {loadScaledMs} from '../../test-helpers/machineLoad.js';

/**
 * Polls `check` every `every` ms until it holds. Fails with "<what> timed out"
 * once `ms`, stretched for the machine's load, pass without it holding. A wait
 * over many passes names what each pass advances in `progress`: the budget then
 * restarts on every change, so the wait fails on a stall, not on a slow machine.
 */
export async function pollUntil(check:()=>boolean,what:string,{ms=5000,every=5,progress}:{ms?:number;every?:number;progress?:()=>unknown}={}):Promise<void> {
  const budget=loadScaledMs(ms);
  let seen=JSON.stringify(progress?.()),end=Date.now()+budget;
  while(!check()){
    const now=JSON.stringify(progress?.());
    if(now!==seen){seen=now;end=Date.now()+budget;}
    if(Date.now()>end)throw new Error(`${what} timed out`+(progress?` at ${now}`:''));
    await new Promise(resolve=>setTimeout(resolve,every));
  }
}
