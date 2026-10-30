import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';
import { OverlayModule } from '@angular/cdk/overlay';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OverlayModule] });
    service = TestBed.inject(ToastService);
  });

  it('creates', () => expect(service).toBeTruthy());

  it('show returns a ToastRef with dismiss', () => {
    const ref = service.show({ message: 'hello' });
    expect(ref.dismiss).toBeDefined();
  });

  it('success shorthand works', () => {
    const ref = service.success('done');
    expect(ref).toBeTruthy();
  });
});
