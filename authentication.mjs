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
  for(const [role,name]of labels){
    const matches=page.getByRole(role,{name});
    for(let i=0;i<await matches.count();i++)if(await matches.nth(i).isVisible())return true;
  }
  return false;
}
