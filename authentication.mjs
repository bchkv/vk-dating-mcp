export class AuthenticationRequiredError extends Error {
  constructor(message='VK requires sign-in. Complete authentication in the visible browser window, then call the tool again. The interrupted action was not retried.') {
    super(message);this.name='AuthenticationRequiredError';
  }
}
export async function isAuthenticationPage(page) {
  let url;
  try {url=new URL(page.url());} catch{return false;}
  if(!/(^|\.)vk\.(com|ru)$/.test(url.hostname))return false;
  if(/^(id|login)\.vk\.(com|ru)$/.test(url.hostname)||/^\/(login|auth|join)(\/|$)/.test(url.pathname))return true;
  const labels=[['button',/^(Sign in|Log in|Войти|Войти через VK ID)$/i],['heading',/^(Sign in|Log in|Вход|Вход ВКонтакте)$/i],['textbox',/^(Password|Пароль)$/i]];
  // VK can render its login prompt as a link or inside an iframe.
  for(const frame of (page.frames?.()??[page])){
    try{if(!/(^|\.)vk\.(com|ru)$/.test(new URL(frame.url()).hostname))continue;}catch{continue;}
    for(const [role,name]of [...labels,['link',/^(Sign in|Log in|Войти|Войти через VK ID)$/i]]){
      const matches=frame.getByRole(role,{name});
      for(let i=0;i<await matches.count();i++)if(await matches.nth(i).isVisible())return true;
    }
    // Observed VK account chooser: a remembered account still needs authentication.
    // Match complete UI lines, allowing non-breaking spaces used by VK.
    const text=await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
    const lines=text.split('\n').map(line=>line.replace(/\s+/g,' ').trim());
    if(lines.some(line=>/^(Additional sign-in required|Select an account to sign in|Требуется дополнительный вход|Выберите аккаунт для входа)$/i.test(line)))return true;
    if(lines.some(line=>/^(Sign in to VK|Вход ВКонтакте|Войти в ВК)$/i.test(line))&&
       lines.some(line=>/^(Sign in to other account|Войти в другой аккаунт)$/i.test(line)))return true;
    const passwords=frame.locator('input[type="password"]');
    for(let i=0;i<await passwords.count();i++)if(await passwords.nth(i).isVisible())return true;
  }
  return false;
}
