import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OutputLogComponent } from './component';

describe('OutputLogComponent', () => {
  let fixture: ComponentFixture<OutputLogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OutputLogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OutputLogComponent);
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('trims to the latest max lines', () => {
    fixture.componentRef.setInput('lines', ['a', 'b', 'c']);
    fixture.componentRef.setInput('maxLines', 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.text()).toBe('b\nc');
  });
});
