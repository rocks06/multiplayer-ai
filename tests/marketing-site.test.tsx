/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import MarketingSite from '../apps/marketing/src/MarketingSite';

afterEach(cleanup);

describe('public marketing site',()=>{
  it('explains the product with one clear heading and no personal founder attribution',()=>{
    const {container}=render(<MarketingSite/>);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading',{level:1,name:/shared workspace for AI agents/i})).toBeVisible();
    expect(screen.getByText(/Multiple agents coordinate work in one persistent room/i)).toBeVisible();
    expect(screen.getByText(/Hermes is the first supported external runtime/i)).toBeVisible();
    expect(screen.queryByText(/Made by Rocco Donadon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/CEO & Founder/i)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/developer beta/i);
    expect(container).not.toHaveTextContent(/10×|hosted agents|mobile push/i);
  });

  it('lets visitors inspect each truthful collaboration state',()=>{
    render(<MarketingSite/>);
    fireEvent.click(screen.getByRole('button',{name:/Drafting waits for Research’s final verification/i}));
    expect(screen.getAllByText('Waiting on Research').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:/Drafting asks a human to authorize publication/i}));
    expect(screen.getAllByText('Waiting for your decision').length).toBeGreaterThan(0);
    expect(screen.getByRole('button',{name:'Review decision'})).toBeEnabled();
  });

  it('makes the human decision demonstration functional rather than decorative',()=>{
    render(<MarketingSite/>);
    fireEvent.click(screen.getByRole('button',{name:'Approve'}));
    expect(screen.getByRole('heading',{name:'Drafting can continue.'})).toBeVisible();
    expect(screen.getByText(/resumes automatically with the exact action/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Review the decision again'}));
    fireEvent.click(screen.getByRole('button',{name:'Reject'}));
    expect(screen.getByRole('heading',{name:'The proposed action stays stopped.'})).toBeVisible();
  });
  /**
   * The private beta is one download, and it is this app.
   *
   * The site used to describe a separate "Multiplayer AI Connector" that a person had to install
   * alongside something else, and offered no way to get anything at all. Both are the same
   * mistake: the Mac app is the product, and a page that describes it must be able to hand it over.
   */
  it('offers the unified app, and never sends anyone to a separate Connector',()=>{
    const {container}=render(<MarketingSite/>);
    const download=[...container.querySelectorAll('a[href="/download"]')];
    expect(download.length).toBeGreaterThan(0);
    expect(screen.getByRole('link',{name:/Download for macOS/i})).toBeVisible();
    expect(container).not.toHaveTextContent(/Multiplayer AI Connector/i);
    expect(container).not.toHaveTextContent(/install the Connector/i);
  });
});
