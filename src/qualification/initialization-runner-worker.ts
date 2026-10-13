/// <reference types="@cloudflare/workers-types" />
interface RunnerEnvironment {INITIALIZER:{invokeFirstBirth():Promise<void>}}
/** Temporary nonpublic scheduled runner. No cron is configured by this offline artifact. */
export default {
 fetch():Response{return new Response(null,{status:503});},
 async scheduled(_controller:ScheduledController,env:RunnerEnvironment):Promise<void>{
  await env.INITIALIZER.invokeFirstBirth();
 }
};
