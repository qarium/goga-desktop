// @vitest-environment jsdom
import {act,cleanup,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {RecentChanges} from '../src/renderer/home/RecentProjectCard';
const owner={kind:'primary',projectId:'p'} as const;
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('reads only visible items and keeps the last actual count after a retry fails',async()=>{
 let seen!:IntersectionObserverCallback;
 vi.stubGlobal('IntersectionObserver',class{constructor(fn:IntersectionObserverCallback){seen=fn} observe(){}disconnect(){}});
 const api={readGitSummary:vi.fn().mockResolvedValueOnce({scope:'p',branch:'main',conflicts:0,changedFiles:2}).mockRejectedValueOnce(Error('git offline'))};window.goga=api as any;
 const nav=vi.fn();render(<RecentChanges owner={owner} onNavigate={nav}/>);expect(api.readGitSummary).not.toHaveBeenCalled();
 act(()=>seen([{isIntersecting:true}] as IntersectionObserverEntry[],{} as any));await screen.findByText('2 файла с изменениями');fireEvent.click(screen.getByRole('button',{name:/Обновить изменения/}));
 await screen.findByText('Данные не обновлены');fireEvent.click(screen.getByText('2 файла с изменениями'));expect(nav).toHaveBeenCalledWith({kind:'changes',owner});expect(api.readGitSummary).toHaveBeenCalledTimes(2);
});
