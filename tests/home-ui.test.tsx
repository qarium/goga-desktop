// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {HomePage,type HomePageProps} from '../src/renderer/home/HomePage';
import type {Run} from '../src/shared/types';
afterEach(cleanup);
const r:Run={id:'run-a',projectId:'p',pipeline:'editor',topic:'',branch:'main',profile:'default',workflow:'define',startedAt:'2026-03-02T02:00:00Z',status:'running'};
const props=():HomePageProps=>({projects:[{id:'p',name:'Project',path:'/tmp/p'}],runs:[r,{...r,id:'run-b',kind:'build',pipeline:'Compilation'}],organization:{groups:[],ungroupedProjectIds:['p']},visits:[],sessionEntries:[],notifications:{byProject:{p:12}},catalogReady:true,onAdd:vi.fn(),onNavigate:vi.fn(),onReconnect:vi.fn()});
it('filters runs but never changes notification scope or marks them read',()=>{
 const p=props();render(<HomePage {...p}/>);expect(screen.getByRole('heading',{name:'Главная'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Сборки'}));expect(screen.queryByText('editor')).toBeNull();expect(screen.getByText('Compilation')).toBeTruthy();
 expect(screen.getByLabelText(/12 непрочитанных уведомлений проекта/)).toBeTruthy();fireEvent.click(screen.getByText('Открыть'));expect(p.onNavigate).toHaveBeenCalledWith({kind:'run',runId:'run-b',owner:{kind:'primary',projectId:'p'}});
});
it('keeps loading, failure and empty states distinct from a real zero',()=>{
 const p=props();const c=render(<HomePage {...p} runsReady={false}/>);expect(screen.getByText('Загружаем запуски…')).toBeTruthy();expect(screen.queryByText('Нет активных запусков')).toBeNull();
 c.rerender(<HomePage {...p} catalogReady={false} catalogError="Нет связи"/>);expect(screen.getByRole('alert')).toBeTruthy();
 c.rerender(<HomePage {...p} projects={[]}/>);fireEvent.click(screen.getByRole('button',{name:'Добавить проект'}));expect(p.onAdd).toHaveBeenCalled();
});
it('never interprets an unverified process as running or offers to restart it',()=>{
 const p=props();render(<HomePage {...p} runs={[{...r,recovery:'unverified',dashboardMessage:'Проверка'}]}/>);expect(screen.getByText('Состояние не подтверждено')).toBeTruthy();
 expect(screen.queryByText('Работает')).toBeNull();expect(screen.queryByText('Восстановить панель')).toBeNull();
});

it('switches the visible language without losing the active build filter or translating a project name', async () => {
 const {setLocale} = await import('../src/shared/i18n');
 const {act} = await import('@testing-library/react');
 const p=props();
 try {
  setLocale('en');
  render(<HomePage {...p} projects={[{...p.projects[0],name:'Проект'}]}/>);
  expect(screen.getByRole('heading',{name:'Home'})).toBeTruthy();
  const button=screen.getByRole('button',{name:'Builds'});
  fireEvent.click(button);
  expect(screen.queryByText('editor')).toBeNull();
  expect(screen.getByText('Compilation')).toBeTruthy();
  expect(screen.getByText('Проект')).toBeTruthy();
  act(()=>{setLocale('ru')});
  expect(screen.getByRole('heading',{name:'Главная'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Сборки'})).toBe(button);
  expect(screen.queryByText('editor')).toBeNull();
 } finally { act(()=>{setLocale('ru')}); }
});
