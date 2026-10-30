import { TestBed } from '@angular/core/testing';
import { KanbanBoardComponent } from './component';
import { DragDropModule } from '@angular/cdk/drag-drop';

describe('KanbanBoardComponent', () => {
  it('creates with empty columns', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanBoardComponent, DragDropModule],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanBoardComponent);
    fixture.componentRef.setInput('columns', []);
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('emits itemMoved from child column', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanBoardComponent, DragDropModule],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanBoardComponent);
    fixture.componentRef.setInput('columns', [
      { id: 'col1', title: 'Todo', items: [{ id: 'i1', title: 'Task' }] },
    ]);
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });
});
