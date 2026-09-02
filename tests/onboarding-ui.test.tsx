/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ContextualOnboarding,onboardingStorageKey,restartOnboarding} from '../apps/web/src/ContextualOnboarding';

/**
 * Six small popovers beside the thing they describe.
 *
 * Not a full-screen tutorial: a tour that covers the product teaches nothing about it, and a
 * person who has already worked out what a room is should be able to leave at any point and never
 * see it again. Each one points at the real element, and the anchors live on the product itself.
 */
describe('first-visit coach marks',()=>{
  const key=onboardingStorageKey('user-1:company-1');
  /** The product surface they attach to, named exactly as the components name it. */
  const surface=<>
    {['rooms','agents','conversation','shared-work','needs-you','live-activity']
      .map(anchor=><div key={anchor} data-onboarding={anchor}>{anchor}</div>)}
  </>;
  const mount=()=>render(<>{surface}<ContextualOnboarding identityKey="user-1:company-1"/></>);

  beforeEach(()=>localStorage.clear());
  afterEach(()=>{cleanup();localStorage.clear()});

  it('starts beside Rooms and walks the six in order',async()=>{
    mount();
    expect(screen.getByRole('dialog',{name:'Onboarding 1 of 6'})).toBeVisible();
    expect(screen.getByText('Rooms are where people and AI agents work together.')).toBeVisible();
    // Nothing is covered: it is one small panel, not a layer over the product.
    expect(screen.getByText('rooms')).toBeVisible();
    // There is nowhere to go back to yet.
    expect(screen.queryByRole('button',{name:'Back'})).toBeNull();

    fireEvent.click(screen.getByRole('button',{name:'Next'}));
    expect(screen.getByText('Connect AI agents already running on your devices.')).toBeVisible();
    expect(screen.getByRole('button',{name:'Back'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Back'}));
    expect(screen.getByRole('dialog',{name:'Onboarding 1 of 6'})).toBeVisible();
  });

  it('ends with Done on the last one, and does not come back',()=>{
    mount();
    for(let step=1;step<6;step++)fireEvent.click(screen.getByRole('button',{name:'Next'}));
    expect(screen.getByRole('dialog',{name:'Onboarding 6 of 6'})).toBeVisible();
    expect(screen.getByText('See what each agent is doing, waiting on, or handing off.')).toBeVisible();

    fireEvent.click(screen.getByRole('button',{name:'Done'}));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem(key)).toBe('done');

    cleanup();mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can be left at any point, and stays left',()=>{
    mount();
    fireEvent.click(screen.getByRole('button',{name:'Next'}));
    fireEvent.click(screen.getByRole('button',{name:'Skip'}));
    expect(screen.queryByRole('dialog')).toBeNull();

    cleanup();mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /// Because somebody who skipped it on day one may want it on day two.
  it('can be asked for again from Settings',()=>{
    localStorage.setItem(key,'done');
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent(window,new Event('mpai:onboarding-restart'));
    expect(screen.getByRole('dialog',{name:'Onboarding 1 of 6'})).toBeVisible();
    // And the exported helper is the same gesture, so Settings cannot drift from this.
    fireEvent.click(screen.getByRole('button',{name:'Skip'}));
    act(()=>restartOnboarding());
    expect(screen.getByRole('dialog',{name:'Onboarding 1 of 6'})).toBeVisible();
  });

  /// One person finishing it must not silence it for the next account on the same machine.
  it('is remembered per person and workspace',()=>{
    localStorage.setItem(onboardingStorageKey('user-2:company-1'),'done');
    mount();
    expect(screen.getByRole('dialog',{name:'Onboarding 1 of 6'})).toBeVisible();
  });
});
