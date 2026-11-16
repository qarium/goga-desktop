// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {HomePage} from '../src/renderer/home/HomePage';
import type {Run} from '../src/shared/types';
afterEach(cleanup);
it('exposes both kinds in the same fact grid, with project counters and no demo-only content',()=>{
 const r:Run={id:'p',projectId:'one',pipeline:'Pipeline',topic:'',branch:'main',startedAt:'2026-01-01T00:00:00Z',profile:'auto',workflow:'Review',status:'running'};
 const {container}=render(<HomePage projects={[{id:'one',path:'/one',name:'One'}]} runs={[r,{...r,id:'b',kind:'build',build:{planPath:'plan.md',planVersion:'1',clean:true,update:true,skipManifestCheck:false}}]} visits={[]} organization={{groups:[],ungroupedProjectIds:['one']}} notifications={{byProject:{one:7}}} sessionEntries={[]} catalogReady onAdd={vi.fn()} onNavigate={vi.fn()}/>);
 expect(container.querySelectorAll('.d-live-run')).toHaveLength(2);expect(container.querySelectorAll('.d-run-facts .d-profile-fact')).toHaveLength(2);expect(container.querySelector('.has-multiple')).toBeTruthy();
 expect(screen.queryByText(/стади|Недавние результаты|Прототип|Последние события/i)).toBeNull();
});
