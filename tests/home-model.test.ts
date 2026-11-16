import {it,expect} from 'vitest';
import type {Run} from '../src/shared/types';
import {createRunProjection,activeSummary,groupActive,contextSuffix} from '../src/renderer/home/model';
const r:Run={id:'r',projectId:'a',pipeline:'Build',profile:null,workflow:null,topic:'x',branch:'x',status:'running',startedAt:'2026-01-01T00:00:00Z',taskSnapshot:{topic:'x',branch:'x',year:'2026',text:'SECRET'}};
it('only known display fields participate in stable projections and counters',()=>{
 const project=createRunProjection(),rows=project([r]);expect(project([{...r,output:{text:'log!',truncated:false}}])).toBe(rows);expect(JSON.stringify(rows)).not.toContain('SECRET');
 const all=project([r,{...r,id:'2',kind:'build'},{...r,id:'3',topic:'y'},{...r,id:'4',recovery:'unverified'}]);
 expect(activeSummary(all)).toMatchObject({pipelines:2,builds:1,projects:1,topics:1,unknownTopics:1,unverified:1});
 expect(groupActive([{id:'a',name:'A',path:'/a'}],all,{groups:[],ungroupedProjectIds:['a']},'build')[0].runs.map(x=>x.id)).toEqual(['2']);
});
it('distinguishes workspace identity without treating revision as a different workspace',()=>{
 const ref={projectId:'p',year:'2026',topic:'topic',branch:'topic',contextId:'a',revision:'1'};
 expect(contextSuffix({kind:'topic',ref},{kind:'topic',ref:{...ref,revision:'2'}})).toBeNull();
 expect(contextSuffix({kind:'topic',ref},{kind:'primary',projectId:'p'})).toBe('Без топика');
 expect(contextSuffix({kind:'topic',ref},{kind:'topic',ref:{...ref,year:'2025'}})).toContain('2025');
});
