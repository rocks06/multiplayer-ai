import {test,expect} from '@playwright/test';

/* Against the real API, database and built web app: signing out lands on Sign in, says nothing was
   lost, keeps creating an account one link away, and signing back in by link returns the same
   workspace. A fresh address per run keeps this clear of the shared fixtures' sign-in allowance. */
test('sign out lands on Sign in, and a new link restores the same workspace',async({browser},testInfo)=>{
 const context=await browser.newContext();
 const page=await context.newPage();
 const email=`signout-${crypto.randomUUID()}@example.test`;
 const tokenFor=async()=>{
  const captured=await context.request.get(`/__e2e/auth-token?email=${encodeURIComponent(email)}`);
  const {token}=await captured.json();expect(token).toBeTruthy();return token as string;
 };
 try{
  // A new account, made the ordinary way, and a workspace in it.
  expect((await context.request.post('/v1/auth/sign-up',{data:{name:'Fixture Person',email}})).ok()).toBeTruthy();
  await page.goto(`/signin?token=${encodeURIComponent(await tokenFor())}`);
  await expect(page).toHaveURL(/\/home$/);
  const workspace=await (await context.request.post('/v1/workspaces',{data:{name:'Fixture Workspace'}})).json();
  expect(workspace.company_id).toBeTruthy();

  // Sign out from Settings.
  await page.goto('/settings');
  await expect(page.getByText(/Signing out ends this session only/)).toBeVisible();
  await page.getByRole('button',{name:'Sign out'}).click();

  // The door is Sign in, it says the account is untouched, and creating one is a link beside it.
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  await expect(page.getByText(/Your account and your workspaces are unchanged/)).toBeVisible();
  await expect(page.getByRole('heading',{name:/Create your account/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create an account'})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('signed-out.png'),fullPage:true});
  // The old session is gone, not merely hidden.
  expect((await context.request.get('/v1/auth/me')).status()).toBe(401);

  // Ask for a link through the screen itself, and follow it.
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByRole('button',{name:'Email me a sign-in link'}).click();
  await expect(page.getByRole('heading',{name:/Check your email|Link issued/})).toBeVisible();
  await page.goto(`/signin?token=${encodeURIComponent(await tokenFor())}`);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading',{name:'Fixture Workspace'})).toBeVisible();

  // Creating an account stays reachable on purpose, one step away from Sign in.
  await context.clearCookies();
  await page.goto('/signin');
  await page.getByRole('button',{name:'Create an account'}).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('heading',{name:'Create your account'})).toBeVisible();
 }finally{await context.close()}
});
