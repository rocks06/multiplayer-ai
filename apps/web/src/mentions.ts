import type {Member,MessageMention} from './types';

/** A participant chosen from the picker: the id is what routes; the name is only what is shown. */
export interface MentionToken {principal_id:string;display_name:string}
export interface MentionRange {principal_id:string;start:number;end:number}

/**
 * The "@…" being typed immediately before the caret, if any.
 *
 * Only an @ at the start or after whitespace opens the picker, so an email address or a price does
 * not. The query stops at whitespace: names can contain spaces, and the picker completes them.
 */
export function mentionQuery(text:string,caret:number):{start:number;query:string}|null{
  const before=text.slice(0,caret);
  const match=/(^|\s)@([^\s@]{0,40})$/.exec(before);
  if(!match)return null;
  return {start:caret-match[2]!.length-1,query:match[2]!};
}

/** Room participants a person could mean, never themselves, best matches first. */
export function mentionCandidates(members:Member[],query:string,selfId:string){
  const q=query.toLocaleLowerCase();
  return members
    .filter(member=>member.principal_id!==selfId&&member.display_name.toLocaleLowerCase().includes(q))
    .sort((a,b)=>{
      const rank=(member:Member)=>member.display_name.toLocaleLowerCase().startsWith(q)?0:1;
      return rank(a)-rank(b)||a.display_name.localeCompare(b.display_name);
    })
    .slice(0,8);
}

/** Replace the typed "@query" with the participant's full "@Name " and put the caret after it. */
export function insertMention(text:string,at:{start:number;query:string},member:Member){
  const token=`@${member.display_name} `;
  const end=at.start+1+at.query.length;
  return {text:text.slice(0,at.start)+token+text.slice(end),caret:at.start+token.length};
}

/**
 * The exact ranges to send, computed on the text actually being sent.
 *
 * Each chosen participant claims the next "@Name" in the text that no other mention has claimed.
 * A chosen mention whose text has since been deleted simply is not sent; "@Name" typed by hand,
 * never chosen, is plain text and routes nobody — only a selection is structure.
 */
export function mentionRanges(body:string,tokens:MentionToken[]):MentionRange[]{
  const ranges:MentionRange[]=[];
  const taken=(start:number,end:number)=>ranges.some(range=>start<range.end&&range.start<end);
  for(const token of tokens){
    const text=`@${token.display_name}`;
    let at=body.indexOf(text);
    while(at>=0&&(taken(at,at+text.length)||/[\p{L}\p{N}_]/u.test(body.charAt(at+text.length))))at=body.indexOf(text,at+1);
    if(at>=0)ranges.push({principal_id:token.principal_id,start:at,end:at+text.length});
  }
  return ranges.sort((a,b)=>a.start-b.start);
}

export type BodySegment={text:string;mention?:MessageMention};

/** Message text split around its mentions, trusting a range only where it still reads "@Name". */
export function bodySegments(body:string,mentions:MessageMention[]|undefined):BodySegment[]{
  const segments:BodySegment[]=[];
  let cursor=0;
  for(const mention of [...(mentions??[])].sort((a,b)=>a.start-b.start)){
    if(mention.start<cursor||mention.end>body.length||body.slice(mention.start,mention.end)!==`@${mention.display_name}`)continue;
    if(mention.start>cursor)segments.push({text:body.slice(cursor,mention.start)});
    segments.push({text:body.slice(mention.start,mention.end),mention});
    cursor=mention.end;
  }
  if(cursor<body.length||!segments.length)segments.push({text:body.slice(cursor)});
  return segments;
}
