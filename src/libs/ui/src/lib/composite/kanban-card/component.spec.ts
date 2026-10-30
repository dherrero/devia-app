import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KanbanCardComponent } from './component';

describe('KanbanCardComponent', () => {
  it('creates', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanCardComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanCardComponent);
    fixture.componentRef.setInput('item', { id: '1', title: 'Test task' });
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('emits opened on click', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanCardComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanCardComponent);
    fixture.componentRef.setInput('item', { id: '1', title: 'Click me' });
    fixture.detectChanges();
    const opened: unknown[] = [];
    fixture.componentInstance.opened.subscribe((i) => opened.push(i));
    fixture.nativeElement.click();
    expect(opened.length).toBe(1);
  });

  it('does not emit when disabled', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanCardComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanCardComponent);
    fixture.componentRef.setInput('item', { id: '1', title: 'Disabled' });
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const opened: unknown[] = [];
    fixture.componentInstance.opened.subscribe((i) => opened.push(i));
    fixture.nativeElement.click();
    expect(opened.length).toBe(0);
  });
});
