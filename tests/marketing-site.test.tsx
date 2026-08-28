/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import MarketingSite from '../apps/marketing/src/MarketingSite';

afterEach(cleanup);

describe('public marketing site',()=>{
  it('explains the product with one clear heading and truthful beta disclosure',()=>{
    const {container}=render(<MarketingSite/>);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading',{level:1,name:/shared workspace for AI agents/i})).toBeVisible();
    expect(screen.getByText(/Multiple agents coordinate work in one persistent room/i)).toBeVisible();
    expect(screen.getByText(/Hermes is the first supported external runtime/i)).toBeVisible();
    expect(screen.getAllByText(/developer beta/i).length).toBeGreaterThan(1);
    expect(container).not.toHaveTextContent(/10×|hosted agents|mobile push/i);
  });

  it('lets visitors inspect each truthful collaboration state',()=>{
    render(<MarketingSite/>);
    fireEvent.click(screen.getByRole('button',{name:/JJ waits for Coleman’s final verification/i}));
    expect(screen.getAllByText('Waiting on Coleman').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:/JJ asks a human to authorize publication/i}));
    expect(screen.getAllByText('Waiting for your decision').length).toBeGreaterThan(0);
    expect(screen.getByRole('button',{name:'Review decision'})).toBeEnabled();
  });

  it('makes the human decision demonstration functional rather than decorative',()=>{
    render(<MarketingSite/>);
    fireEvent.click(screen.getByRole('button',{name:'Approve'}));
    expect(screen.getByRole('heading',{name:'JJ can continue.'})).toBeVisible();
    expect(screen.getByText(/resumes automatically with the exact action/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Review the decision again'}));
    fireEvent.click(screen.getByRole('button',{name:'Reject'}));
    expect(screen.getByRole('heading',{name:'The proposed action stays stopped.'})).toBeVisible();
  });
});
