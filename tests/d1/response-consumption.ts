// Status-only fixtures must release their bounded reply in the first continuation.
// Body-oracle fixtures consume and assert their own payload instead.
export async function consumedStatus(response:{status:number;body:{cancel():Promise<void>}|null}):Promise<number>{
 const status=response.status;
 if(response.body)await response.body.cancel();
 return status;
}
