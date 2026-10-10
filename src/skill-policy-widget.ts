/** Owner-only, deliberately compact MCP App for skill preference edits.
 * The app talks through the authenticated MCP host bridge; it has no
 * direct HTTP route and never asks for another password.
 */
export const SKILL_POLICY_WIDGET_URI = "ui://devos/skill-policy-v1.html";

export function skillPolicyWidget(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
body{font:14px system-ui,sans-serif;padding:12px;color:CanvasText;background:Canvas;margin:0}
label{display:block;margin:8px 0 3px}
select,input{font:inherit;color:inherit;background:transparent;border:1px solid #999;
  border-radius:8px;box-sizing:border-box;width:100%;padding:9px}
button{font:inherit;border-radius:8px;border:1px solid #888;padding:9px 12px;
  margin-top:12px;color:inherit;background:transparent}
button:disabled{opacity:.55}#note{white-space:pre-wrap;margin-top:9px}
small{opacity:.7}
</style>
</head>
<body>
<h3>DevOS — навыки</h3>
<small>Изменения применяются к новым задачам. Текущий граф воркеров не меняется.</small>
<form id="settings">
<label for="skill">Навык</label><select id="skill" required></select>
<label for="mode">Режим</label><select id="mode"><option>required</option>
<option>optional</option><option>off</option></select>
<label for="scope">Область</label><select id="scope"><option>global</option>
<option>project</option><option>role</option><option>task</option></select>
<label for="context">Контекст</label><input id="context" placeholder="owner/repo, role или owner/repo#issue">
<button type="submit" id="save" disabled>Сохранить</button>
<button type="button" id="refresh">Обновить</button>
<div role="status" aria-live="polite" id="note">Получение настроек...</div>
</form>
<script>
(()=>{"use strict";
const $=id=>document.getElementById(id);
let fingerprint="",skills=[];
function say(s){$("note").textContent=s}
function updateContext(){
 const s=$("scope").value;
 $("context").disabled=s==="global";
 $("context").placeholder=s==="project"?"owner/repo":
   s==="role"?"developer или reviewer":
   s==="task"?"owner/repo#issue":"Не используется";
 if(s==="global")$("context").value="";
}
$("scope").addEventListener("change",updateContext);
function payload(result){
 if(!result)return null;
 if(result.structuredContent)return result.structuredContent;
 if(result.content?.[0]?.text){
   try{return JSON.parse(result.content[0].text)}catch{}
 }
 return result;
}
async function load(){
 if(typeof window.openai?.callTool!=="function"){
   say("Эта версия ChatGPT не поддерживает отправку MCP App tool calls. Настрой навыки через devos_skill_policy_get / devos_skill_policy_set в чате.");
   return;
 }
 $("save").disabled=true;
 try {
   const output=payload(await window.openai.callTool("devos_skill_policy_get",{}));
   if(!output?.fingerprint||!Array.isArray(output.skills))throw Error("Unexpected MCP response");
   fingerprint=output.fingerprint;skills=output.skills;
   const select=$("skill");select.replaceChildren();
   for(const skill of skills){
     const opt=document.createElement("option");opt.value=skill.id;
     opt.textContent=skill.name+" ("+skill.version+")";select.appendChild(opt);
   }
   $("save").disabled=!skills.length;
   say("Настройки получены. Выбери навык и область.");
 }catch(e){say("Не удалось получить настройки: "+(e?.message||String(e)))}
}
$("settings").addEventListener("submit",async e=>{
 e.preventDefault();
 if(!$("skill").value||!fingerprint)return;
 $("save").disabled=true;
 try{
   const args={skill_id:$("skill").value,mode:$("mode").value,
     scope:$("scope").value,expected_fingerprint:fingerprint};
   if(args.scope!=="global")args.context=$("context").value.trim();
   const result=payload(await window.openai.callTool("devos_skill_policy_set",args));
   if(result?.isError||!result?.updated)throw Error(result?.error||"Update not confirmed");
   fingerprint=result.fingerprint;
   say("Сохранено в Git-backed конфигурации Staging; новые задачи используют эту настройку.");
 }catch(e){say("Изменение не сохранено: "+(e?.message||String(e)))}
 finally{$("save").disabled=false}
});
$("refresh").addEventListener("click",load);
updateContext();
load();
})();
</script>
</body></html>`;
}
